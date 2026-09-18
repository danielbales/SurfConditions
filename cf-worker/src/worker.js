// Surf Alerts — Cloudflare Worker
// Handles push subscriptions, notification dispatch, and scheduled condition checks.
//
// Environment variables (set via `wrangler secret put`):
//   VAPID_PUBLIC_KEY  — base64url uncompressed EC point (65 bytes)
//   VAPID_PRIVATE_KEY — base64url raw private scalar (32 bytes)
//   NOTIFY_SECRET     — shared secret for the /notify endpoint
//
// KV binding: SURF_SUBS

const VAPID_SUBJECT = 'mailto:dbales1210@gmail.com';
const COOLDOWN_SEC  = 4 * 60 * 60; // 4 hours per spot

// Only requests from this origin are allowed to subscribe/unsubscribe
const ALLOWED_ORIGINS = new Set(['https://danielbales.github.io']);

// ─── Spot definitions ─────────────────────────────────────────────────────────
const SPOTS = {
  carmel: {
    name: 'Carmel Beach',
    lat: 36.5535, lng: -121.9255,
    noaaStation: '9413450',
    check(marine, wind, tide) {
      if (marine.swellFt < 6.0)                       return null;
      if (marine.swellPeriod < 5 || marine.swellPeriod > 12) return null;
      if (tide === null || tide < 3.0)                 return null;
      if (!inRange(wind.dir, 22.5, 112.5))             return null; // E or NE
      return `${marine.swellFt}ft @ ${marine.swellPeriod}s · Tide ${tide}ft · Wind ${dirLabel(wind.dir)} ${wind.speed}mph`;
    },
  },
  asilomar: {
    name: 'Asilomar',
    lat: 36.6213, lng: -121.9427,
    noaaStation: null,
    check(marine, wind) {
      if (marine.swellFt < 4.0)              return null;
      if (!inRange(wind.dir, 67.5, 202.5))   return null; // S, SE, or E
      return `${marine.swellFt}ft @ ${marine.swellPeriod}s · Wind ${dirLabel(wind.dir)} ${wind.speed}mph`;
    },
  },
  mosslanding: {
    name: 'Moss Landing',
    lat: 36.8035, lng: -121.7909,
    noaaStation: null,
    check(marine, wind) {
      if (marine.swellFt < 4.0)              return null;
      if (marine.swellPeriod < 10)           return null; // groundswell only — closes out on windswell
      if (!inRange(wind.dir, 22.5, 157.5))   return null; // NE through SE (offshore-ish)
      return `${marine.swellFt}ft @ ${marine.swellPeriod}s · Wind ${dirLabel(wind.dir)} ${wind.speed}mph`;
    },
  },
};

// ─── Direction helpers ────────────────────────────────────────────────────────
function inRange(deg, lo, hi) { return deg >= lo && deg <= hi; }

function dirLabel(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ─── Data fetchers ────────────────────────────────────────────────────────────
async function fetchMarine(lat, lng) {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}`
    + `&current=wave_height,wave_period,swell_wave_height,swell_wave_period&timezone=America/Los_Angeles`;
  const r = await fetch(url);
  const c = (await r.json()).current;
  const swellM  = c.swell_wave_height  ?? c.wave_height  ?? 0;
  const wavePer = c.swell_wave_period  ?? c.wave_period  ?? 0;
  return {
    swellFt:     Math.round(swellM * 3.28084 * 10) / 10,
    swellPeriod: Math.round(wavePer * 10) / 10,
  };
}

async function fetchWind(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
    + `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph&timezone=America/Los_Angeles`;
  const r = await fetch(url);
  const c = (await r.json()).current;
  return {
    speed: Math.round((c.wind_speed_10m ?? 0) * 10) / 10,
    dir:   Math.round(c.wind_direction_10m ?? 0),
  };
}

async function fetchTide(station) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
    + `?station=${station}&product=water_level&datum=MLLW`
    + `&time_zone=lst_ldt&units=english&format=json&begin_date=${today}&end_date=${today}`;
  const r = await fetch(url);
  const data = (await r.json()).data ?? [];
  if (!data.length) return null;
  return Math.round(parseFloat(data[data.length - 1].v) * 100) / 100;
}

// ─── CORS + response helpers ──────────────────────────────────────────────────

// Returns the request's Origin if it's in the allowlist, otherwise null.
function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') ?? '';
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

// Builds a response with appropriate CORS headers.
// `origin` should be the validated Origin string (or null to use the first allowed origin as default).
function respond(body, status = 200, origin = null, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  origin ?? [...ALLOWED_ORIGINS][0],
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Notify-Secret',
      'Vary': 'Origin',
      ...extra,
    },
  });
}

// ─── Rate limiting (KV-based, per IP) ────────────────────────────────────────
// Allows up to `limit` requests from a single IP within `windowSec` seconds.
// Uses a KV key per IP with a rolling TTL — cheap and sufficient for abuse prevention.
async function checkRateLimit(env, ip, limit = 10, windowSec = 60) {
  const key = `rl_${ip}`;
  const val   = await env.SURF_SUBS.get(key);
  const count = val ? parseInt(val, 10) : 0;
  if (count >= limit) return false;
  // Increment counter; reset window on first hit
  await env.SURF_SUBS.put(key, String(count + 1), { expirationTtl: windowSec });
  return true;
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
  const header  = { typ: 'JWT', alg: 'ES256' };
  const now     = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 43200, sub: VAPID_SUBJECT };
  const encode  = obj => btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const unsigned = `${encode(header)}.${encode(payload)}`;

  const pubBytes = b64urlDecode(env.VAPID_PUBLIC_KEY);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: env.VAPID_PRIVATE_KEY,
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    key_ops: ['sign'],
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64urlEncode(sig)}`;
}

// ─── Push fanout ──────────────────────────────────────────────────────────────
async function broadcastPush(env, title, body) {
  await env.SURF_SUBS.put('_latest_alert', JSON.stringify({ title, body }), { expirationTtl: 3600 });

  const list = await env.SURF_SUBS.list();
  await Promise.all(
    list.keys.filter(k => !k.name.startsWith('_')).map(async k => {
      try {
        const sub = JSON.parse(await env.SURF_SUBS.get(k.name));
        const audience = new URL(sub.endpoint).origin;
        const jwt = await buildVapidJWT(env, audience);
        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
            'TTL': '86400', 'Urgency': 'high', 'Content-Length': '0',
          },
        });
        if (res.status === 410 || res.status === 404) await env.SURF_SUBS.delete(k.name);
      } catch {}
    })
  );
}

// ─── Scheduled condition check (runs every 10 min via cron) ───────────────────
async function checkConditions(env) {
  for (const [key, spot] of Object.entries(SPOTS)) {
    if (await env.SURF_SUBS.get(`_cooldown_${key}`)) continue;

    try {
      const [marine, wind] = await Promise.all([
        fetchMarine(spot.lat, spot.lng),
        fetchWind(spot.lat, spot.lng),
      ]);
      const tide = spot.noaaStation ? await fetchTide(spot.noaaStation) : null;
      const msg  = spot.check(marine, wind, tide);

      if (msg) {
        await broadcastPush(env, `🌊 ${spot.name} is firing!`, msg);
        await env.SURF_SUBS.put(`_cooldown_${key}`, '1', { expirationTtl: COOLDOWN_SEC });
      }
    } catch (e) {
      console.error(`[surf-alerts] ${key} check failed:`, e.message);
    }
  }
}

// ─── Fetch handler (HTTP endpoints) ──────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = getAllowedOrigin(request);

    // Preflight
    if (request.method === 'OPTIONS') return respond(null, 204, origin);

    // POST /subscribe — origin-restricted + rate-limited
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      if (!origin) return respond('Forbidden', 403, null);

      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!(await checkRateLimit(env, ip))) return respond('Too Many Requests', 429, origin);

      const { subscription } = await request.json();
      if (!subscription?.endpoint) return respond('Bad Request', 400, origin);
      await env.SURF_SUBS.put(
        `sub_${crypto.randomUUID()}`,
        JSON.stringify(subscription),
        { expirationTtl: 60 * 60 * 24 * 90 }
      );
      return respond('ok', 200, origin);
    }

    // DELETE /unsubscribe — origin-restricted
    if (request.method === 'DELETE' && url.pathname === '/unsubscribe') {
      if (!origin) return respond('Forbidden', 403, null);

      const { endpoint } = await request.json();
      const list = await env.SURF_SUBS.list();
      for (const k of list.keys.filter(k => !k.name.startsWith('_'))) {
        const sub = JSON.parse(await env.SURF_SUBS.get(k.name));
        if (sub.endpoint === endpoint) { await env.SURF_SUBS.delete(k.name); break; }
      }
      return respond('ok', 200, origin);
    }

    // GET /alert — public (service worker fetches this on push receipt, no Origin header)
    if (request.method === 'GET' && url.pathname === '/alert') {
      const raw = await env.SURF_SUBS.get('_latest_alert');
      const payload = raw ?? JSON.stringify({ title: '🌊 Surf Alert', body: 'Check conditions now' });
      return respond(payload, 200, origin, { 'Content-Type': 'application/json' });
    }

    // POST /notify — secret-protected, no origin restriction (server-to-server)
    if (request.method === 'POST' && url.pathname === '/notify') {
      if (request.headers.get('X-Notify-Secret') !== env.NOTIFY_SECRET) return respond('Forbidden', 403, null);
      const { title, body } = await request.json();
      if (!title) return respond('Bad Request', 400, null);
      await broadcastPush(env, title, body);
      return respond('ok', 200, null);
    }

    // POST /check — secret-protected manual trigger for testing
    if (request.method === 'POST' && url.pathname === '/check') {
      if (request.headers.get('X-Notify-Secret') !== env.NOTIFY_SECRET) return respond('Forbidden', 403, null);
      await checkConditions(env);
      return respond('ok', 200, null);
    }

    // GET /proxy/ndbc/:buoyId — public NDBC realtime data proxy (no origin restriction)
    if (request.method === 'GET' && url.pathname.startsWith('/proxy/ndbc/')) {
      const buoyId = url.pathname.split('/')[3];
      if (!buoyId || !/^\d+$/.test(buoyId)) {
        return respond(JSON.stringify({ ok: false, error: 'Invalid buoy ID' }), 400, '*', {
          'Content-Type': 'application/json',
        });
      }

      try {
        const [metRes, specRes] = await Promise.all([
          fetch(`https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.txt`),
          fetch(`https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.spec`),
        ]);

        if (!metRes.ok) {
          return respond(JSON.stringify({ ok: false, error: `NDBC met fetch failed: ${metRes.status}` }), 502, '*', {
            'Content-Type': 'application/json',
          });
        }

        // Parse standard met file
        const metText = await metRes.text();
        const metLines = metText.trim().split('\n');
        // First two lines are headers (start with #), data starts at line index 2
        if (metLines.length < 3) {
          return respond(JSON.stringify({ ok: false, error: 'No met data available' }), 502, '*', {
            'Content-Type': 'application/json',
          });
        }
        // Columns: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
        const mm = (v) => (v === 'MM' ? null : parseFloat(v));

        // Latest line for wind/temp (always present even when wave is MM)
        const latestCols = metLines[2].trim().split(/\s+/);
        const metYear = latestCols[0], metMonth = latestCols[1], metDay = latestCols[2];
        const metHour = latestCols[3], metMin = latestCols[4];
        const time = `${metYear}-${metMonth}-${metDay}T${metHour}:${metMin}:00Z`;
        const wdir = mm(latestCols[5]);
        const wspd = mm(latestCols[6]);
        const gst  = mm(latestCols[7]);
        const wtmp = mm(latestCols[14]);

        // Scan recent lines for first one with actual wave data (WVHT != MM)
        let wvht = null, dpd = null, mwd = null;
        for (let li = 2; li < Math.min(metLines.length, 14); li++) {
          const c = metLines[li].trim().split(/\s+/);
          if (c[8] && c[8] !== 'MM') {
            wvht = mm(c[8]);
            dpd  = mm(c[9]);
            mwd  = mm(c[11]);
            break;
          }
        }

        // Parse spectral file — scan for first line with wave data
        let swell = null;
        let windWave = null;
        if (specRes.ok) {
          const specText = await specRes.text();
          const specLines = specText.trim().split('\n');
          for (let li = 2; li < Math.min(specLines.length, 14); li++) {
            const specCols = specLines[li].trim().split(/\s+/);
            // Columns: YY MM DD hh mm WVHT SwH SwP SwD WWH WWP WWD STEEPNESS APD MWD
            if (specCols[5] && specCols[5] !== 'MM') {
              swell    = { height_m: mm(specCols[6]), period_s: mm(specCols[7]), direction: mm(specCols[8]) };
              windWave = { height_m: mm(specCols[9]), period_s: mm(specCols[10]), direction: mm(specCols[11]) };
              break;
            }
          }
        }

        const result = {
          ok: true,
          buoyId,
          time,
          wave: { height_m: wvht, period_s: dpd, direction: mwd },
          swell,
          windWave,
          wind: { speed_ms: wspd, gust_ms: gst, direction: wdir },
          waterTemp_c: wtmp,
        };

        return respond(JSON.stringify(result), 200, '*', {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600',
        });
      } catch (e) {
        return respond(JSON.stringify({ ok: false, error: e.message }), 500, '*', {
          'Content-Type': 'application/json',
        });
      }
    }

    return respond('Not Found', 404, origin);
  },

  // Runs every 10 minutes via cron trigger in wrangler.toml
  async scheduled(event, env) {
    await checkConditions(env);
  },
};
