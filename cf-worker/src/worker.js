// Surf Alerts — Cloudflare Worker
// Handles push subscription storage and notification dispatch.
//
// Environment variables (set via `wrangler secret put`):
//   VAPID_PUBLIC_KEY  — base64url uncompressed EC point (65 bytes)
//   VAPID_PRIVATE_KEY — base64url raw private scalar (32 bytes)
//   NOTIFY_SECRET     — shared secret used by surf_alert.py
//
// KV binding (wrangler.toml):
//   SURF_SUBS — stores push subscriptions

const VAPID_SUBJECT = 'mailto:dbales1210@gmail.com';

// ─── CORS headers ────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Notify-Secret',
};

function cors(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...CORS, ...extra } });
}

// ─── Base64url helpers ────────────────────────────────────────────────────────
function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(pad));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function b64urlEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ─── VAPID JWT ────────────────────────────────────────────────────────────────
async function buildVapidJWT(env, audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 43200, sub: VAPID_SUBJECT };

  const encode = obj =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const unsigned = `${encode(header)}.${encode(payload)}`;

  // Build JWK from raw VAPID keys
  const pubBytes = b64urlDecode(env.VAPID_PUBLIC_KEY); // 65 bytes: 0x04 || x || y
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: env.VAPID_PRIVATE_KEY,
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    key_ops: ['sign'],
  };

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${b64urlEncode(sig)}`;
}

// ─── Send blank push to one subscription ────────────────────────────────────
async function sendPush(env, subscription) {
  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const jwt = await buildVapidJWT(env, audience);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'TTL': '86400',
      'Urgency': 'high',
      'Content-Length': '0',
    },
  });
  return res;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') return cors(null);

    // POST /subscribe — web app registers its push subscription
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const { subscription } = await request.json();
      if (!subscription?.endpoint) return cors('Bad Request', 400);
      const key = `sub_${crypto.randomUUID()}`;
      await env.SURF_SUBS.put(key, JSON.stringify(subscription), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days
      return cors('ok');
    }

    // GET /alert — service worker fetches the latest alert message after a push
    if (request.method === 'GET' && url.pathname === '/alert') {
      const raw = await env.SURF_SUBS.get('_latest_alert');
      if (!raw) return cors(JSON.stringify({ title: '🌊 Surf Alert', body: 'Check conditions now' }),
        200, { 'Content-Type': 'application/json' });
      return cors(raw, 200, { 'Content-Type': 'application/json' });
    }

    // POST /notify — Python script triggers a push broadcast
    if (request.method === 'POST' && url.pathname === '/notify') {
      const secret = request.headers.get('X-Notify-Secret');
      if (secret !== env.NOTIFY_SECRET) return cors('Forbidden', 403);

      const { title, body } = await request.json();
      if (!title) return cors('Bad Request', 400);

      // Store latest alert for SW to fetch
      await env.SURF_SUBS.put('_latest_alert', JSON.stringify({ title, body }), { expirationTtl: 3600 });

      // Fan out push to all subscriptions
      const list = await env.SURF_SUBS.list();
      const results = { sent: 0, removed: 0, errors: 0 };

      await Promise.all(
        list.keys
          .filter(k => !k.name.startsWith('_'))
          .map(async k => {
            try {
              const sub = JSON.parse(await env.SURF_SUBS.get(k.name));
              const res = await sendPush(env, sub);
              if (res.status === 410 || res.status === 404) {
                await env.SURF_SUBS.delete(k.name); // subscription expired
                results.removed++;
              } else if (res.ok || res.status === 201) {
                results.sent++;
              } else {
                results.errors++;
              }
            } catch {
              results.errors++;
            }
          })
      );

      return cors(JSON.stringify(results), 200, { 'Content-Type': 'application/json' });
    }

    // DELETE /unsubscribe — web app removes its subscription (optional)
    if (request.method === 'DELETE' && url.pathname === '/unsubscribe') {
      const { endpoint } = await request.json();
      const list = await env.SURF_SUBS.list();
      for (const k of list.keys.filter(k => !k.name.startsWith('_'))) {
        const sub = JSON.parse(await env.SURF_SUBS.get(k.name));
        if (sub.endpoint === endpoint) {
          await env.SURF_SUBS.delete(k.name);
          break;
        }
      }
      return cors('ok');
    }

    return cors('Not Found', 404);
  },
};
