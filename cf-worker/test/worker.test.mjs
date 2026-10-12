import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import worker, {
  checkRateLimit,
  encryptPushBody,
  isAllowedOrigin,
  pacificYYYYMMDD,
  parsePacificDateTime,
  spotAlertMessage,
  tideNowFromPredictions,
} from '../src/worker.js';

function mockKV() {
  const store = new Map();
  return {
    async get(key) {
      const row = store.get(key);
      if (!row) return null;
      if (row.exp && row.exp < Date.now()) {
        store.delete(key);
        return null;
      }
      return row.val;
    },
    async put(key, val, opts = {}) {
      const ttl = opts.expirationTtl;
      store.set(key, { val, exp: ttl ? Date.now() + ttl * 1000 : null });
    },
    async delete(key) { store.delete(key); },
    async list(opts = {}) {
      const names = [...store.keys()];
      return { keys: names.map(name => ({ name })), list_complete: true, cursor: opts.cursor };
    },
  };
}

function concatBytes(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm);
  const block = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return block.slice(0, length);
}

// Independent of the worker's encrypt function: same RFC, written here so a
// shared mistake does not hide itself.
async function decryptPushBody(body, uaPrivate, uaPublic, auth) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivate, 256));
  const ikm = await hkdf(auth, shared, concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--;
  assert.equal(record[end - 1], 2);
  return JSON.parse(new TextDecoder().decode(record.slice(0, end - 1)));
}

test('pacific date stays on today after 5pm Pacific', () => {
  // 03:00 UTC on Oct 13 is 8pm the previous evening in Pacific daylight time.
  const evening = new Date('2026-10-13T03:00:00Z');
  assert.equal(pacificYYYYMMDD(evening), '20261012');
  assert.equal(evening.toISOString().slice(0, 10).replace(/-/g, ''), '20261013');
  assert.equal(pacificYYYYMMDD(new Date('2026-10-13T08:30:00Z')), '20261013');
});

test('subordinate tide stations can still produce a height for alerts', () => {
  const now = parsePacificDateTime('2026-10-12 12:00');
  const height = tideNowFromPredictions([
    { t: '2026-10-12 11:30', v: '2.0', type: 'L' },
    { t: '2026-10-12 17:30', v: '6.0', type: 'H' },
  ], now);
  assert.ok(height > 2 && height < 6);
  assert.equal(parsePacificDateTime('2026-10-12 20:00').toISOString(), '2026-10-13T03:00:00.000Z');
});

test('Carmel period rule is unchanged and alerts use knots', () => {
  const wind = { speed: 8, dir: 70 };
  const tide = 4;
  assert.equal(spotAlertMessage('carmel', { swellFt: 7, swellPeriod: 14 }, wind, tide), null);
  assert.equal(spotAlertMessage('carmel', { swellFt: 7, swellPeriod: 4 }, wind, tide), null);
  const msg = spotAlertMessage('carmel', { swellFt: 7, swellPeriod: 8 }, wind, tide);
  assert.match(msg, /7ft @ 8s/);
  assert.match(msg, /8 kt/);
  assert.doesNotMatch(msg, /mph/);
});

test('relay origin allowlist', () => {
  assert.equal(isAllowedOrigin('https://danielbales.github.io'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8080'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin(''), false);
});

test('ndbc relay rejects other websites before calling NOAA', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response('no'); };
  try {
    const res = await worker.fetch(new Request('https://surf.example/proxy/ndbc/46236', {
      headers: { Origin: 'https://evil.example' },
    }), { SURF_SUBS: mockKV() });
    assert.equal(res.status, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('rate limit is per bucket so the map and subscribe do not share a counter', async () => {
  const env = { SURF_SUBS: mockKV() };
  assert.equal(await checkRateLimit(env, '1.2.3.4', 2, 60, 'ndbc'), true);
  assert.equal(await checkRateLimit(env, '1.2.3.4', 2, 60, 'ndbc'), true);
  assert.equal(await checkRateLimit(env, '1.2.3.4', 2, 60, 'ndbc'), false);
  assert.equal(await checkRateLimit(env, '1.2.3.4', 2, 60, 'gen'), true);
});

test('each push body decrypts to its own alert', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64 = bytes => Buffer.from(bytes).toString('base64url');
  const sub = { keys: { p256dh: b64(uaPublic), auth: b64(auth) } };

  const carmel = { title: 'Carmel', body: '6 ft', tag: 'surf-carmel' };
  const steamer = { title: 'Steamer', body: '4 ft', tag: 'surf-steamer' };
  const a = await decryptPushBody(await encryptPushBody(sub, carmel), pair.privateKey, uaPublic, auth);
  const b = await decryptPushBody(await encryptPushBody(sub, steamer), pair.privateKey, uaPublic, auth);
  assert.deepEqual(a, carmel);
  assert.deepEqual(b, steamer);
  assert.notEqual(a.tag, b.tag);
});

test('saved beaches keep a deletion and pick up the new stations', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../../web/spot-stations.js', import.meta.url), 'utf8'), ctx);
  const saved = [
    { id: 'carmel', name: 'Carmel Beach', buoyId: '46042', tideStation: '9413450', beachFacing: 280 },
    { id: 'asilomar', buoyId: '46042', tideStation: '9413450' },
    { id: 'bigsur', buoyId: '46042', tideStation: '9413450' },
    { id: 'steamer', buoyId: '46042', tideStation: '9413450' },
    { id: 'custom', name: 'Pipeline', lat: 21.66, lng: -158.05 },
  ];
  const next = ctx.applyBuiltinStations(saved);
  assert.equal(next.length, saved.length);
  assert.equal(next.find(s => s.id === 'mosslanding'), undefined);
  assert.equal(next.find(s => s.id === 'carmel').buoyId, '46236');
  assert.equal(next.find(s => s.id === 'carmel').buoyName, 'Monterey Canyon');
  assert.equal(next.find(s => s.id === 'carmel').tideStation, '9413375');
  assert.equal(next.find(s => s.id === 'carmel').tideStationName, 'Carmel Cove');
  assert.equal(next.find(s => s.id === 'asilomar').tideStation, '9413450');
  assert.equal(next.find(s => s.id === 'asilomar').tideStationName, 'Monterey Harbor');
  assert.equal(next.find(s => s.id === 'bigsur').buoyId, '46239');
  assert.equal(next.find(s => s.id === 'bigsur').tideStationName, 'Carmel Cove');
  assert.equal(next.find(s => s.id === 'steamer').buoyId, '46253');
  assert.equal(next.find(s => s.id === 'steamer').tideStation, '9413745');
  assert.equal(next.find(s => s.id === 'custom').buoyId, undefined);

  const app = fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  assert.equal(app.includes("s.id === 'mosslanding'"), false);
  assert.match(app, /rotate\(\$\{w\.dir \+ 180\}deg\)[\s\S]{0,80}↑/);
  assert.doesNotMatch(app, /id="wind-badge"|setBadge\('wind-badge'/);
  assert.match(app, /Offline — can’t refresh/);
  assert.match(app, /stillCurrent\(gen, spotId\)/);
});

test('a vertical swipe scrolls and a sideways swipe scrubs', () => {
  const app = fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const src = app.match(/function chartGesture\(dx, dy\) \{[\s\S]*?\n\}/)[0]
    + '\n' + app.match(/function bestWindowKicker\(start, now\) \{[\s\S]*?\n\}/)[0];
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.equal(ctx.chartGesture(2, 3), null);
  assert.equal(ctx.chartGesture(24, 6), 'scrub');
  assert.equal(ctx.chartGesture(6, 24), 'scroll');
  const today = new Date('2026-10-12T18:00:00');
  assert.equal(ctx.bestWindowKicker(today, today), 'Best window today');
  assert.equal(ctx.bestWindowKicker(new Date('2026-10-13T09:00:00'), today), 'Next best window');
  assert.match(app, /touch-action:pan-y/);
  assert.match(app, /surf_last_reading_v1/);
  assert.match(app, /setTimeout\(tick, 80\)/);
  assert.doesNotMatch(app, /id="rip-body"|card-rip/);
});
