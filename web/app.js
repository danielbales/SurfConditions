// ─── Locations ────────────────────────────────────────────────────────────────
const LOCATIONS = [
  { id: 'carmel',      name: 'Carmel',       lat: 36.5535, lng: -121.9255, tideStation: '9413450', marineZone: 'PZZ535' },
  { id: 'asilomar',    name: 'Asilomar',     lat: 36.6213, lng: -121.9427, tideStation: '9413450', marineZone: 'PZZ535' },
  { id: 'bigsur',      name: 'Big Sur',      lat: 36.2344, lng: -121.8173, tideStation: '9413450', marineZone: 'PZZ565' },
  { id: 'steamerlane', name: 'Steamer Lane', lat: 36.9517, lng: -122.0245, tideStation: '9413745', marineZone: 'PZZ535' },
];

const savedId = localStorage.getItem('surf_location') || 'carmel';
let ACTIVE = LOCATIONS.find(l => l.id === savedId) || LOCATIONS[0];

function setLocation(id) {
  ACTIVE = LOCATIONS.find(l => l.id === id) || LOCATIONS[0];
  localStorage.setItem('surf_location', ACTIVE.id);
  // Update selector UI
  document.querySelectorAll('.loc-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === ACTIVE.id);
  });
  // Update subtitle
  const sub = document.getElementById('location-subtitle');
  if (sub) sub.textContent = `${ACTIVE.name} · ${ACTIVE.lat.toFixed(1)}°N ${Math.abs(ACTIVE.lng).toFixed(1)}°W`;
  refreshAll();
}

// Convenience accessors used throughout
function LAT()          { return ACTIVE.lat; }
function LNG()          { return ACTIVE.lng; }
function NOAA_STATION() { return ACTIVE.tideStation; }
function MARINE_ZONE()  { return ACTIVE.marineZone; }

// ─── Service Worker ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function mpsToKnots(mps) { return mps * 1.94384; }
function mpsToMph(mps) { return mps * 2.23694; }
function metersToFeet(m) { return m * 3.28084; }

function degToCompass(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

function windClass(knots) {
  if (knots < 5)  return ['wind-calm',   'Calm'];
  if (knots < 11) return ['wind-light',  'Light'];
  if (knots < 17) return ['wind-mod',    'Moderate'];
  if (knots < 22) return ['wind-fresh',  'Fresh'];
  if (knots < 34) return ['wind-strong', 'Strong'];
  return ['wind-gale', 'Gale'];
}

function uvCategory(uv) {
  if (uv < 3)  return { label: 'Low',       color: '#00c853', bg: 'rgba(0,200,83,0.15)' };
  if (uv < 6)  return { label: 'Moderate',  color: '#ffeb3b', bg: 'rgba(255,235,59,0.15)' };
  if (uv < 8)  return { label: 'High',      color: '#ff9800', bg: 'rgba(255,152,0,0.15)' };
  if (uv < 11) return { label: 'Very High', color: '#f44336', bg: 'rgba(244,67,54,0.15)' };
  return { label: 'Extreme', color: '#9c27b0', bg: 'rgba(156,39,176,0.15)' };
}

function fmt12(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setBadge(id, label, color, bg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = label; el.style.color = color; el.style.background = bg; }
}

function loadingHTML() {
  return '<div class="loading"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div>';
}

function errorHTML(msg) {
  return `<div class="error-msg">⚠ ${msg}</div>`;
}

// ─── Moon Phase ───────────────────────────────────────────────────────────────
function getMoonPhase(date = new Date()) {
  // Known new moon: Jan 6, 2000
  const known = new Date('2000-01-06T18:14:00Z');
  const LUNAR_CYCLE = 29.530588853;
  const diff = (date - known) / (1000 * 60 * 60 * 24);
  const phase = ((diff % LUNAR_CYCLE) + LUNAR_CYCLE) % LUNAR_CYCLE;
  const fraction = phase / LUNAR_CYCLE;

  let name, icon;
  if (phase < 1.85)        { name = 'New Moon';        icon = '🌑'; }
  else if (phase < 5.54)   { name = 'Waxing Crescent'; icon = '🌒'; }
  else if (phase < 9.22)   { name = 'First Quarter';   icon = '🌓'; }
  else if (phase < 12.91)  { name = 'Waxing Gibbous';  icon = '🌔'; }
  else if (phase < 16.61)  { name = 'Full Moon';       icon = '🌕'; }
  else if (phase < 20.30)  { name = 'Waning Gibbous';  icon = '🌖'; }
  else if (phase < 23.99)  { name = 'Last Quarter';    icon = '🌗'; }
  else if (phase < 27.68)  { name = 'Waning Crescent'; icon = '🌘'; }
  else                     { name = 'New Moon';        icon = '🌑'; }

  // Days to next full moon
  const daysToFull = phase < 14.77
    ? (14.77 - phase)
    : (LUNAR_CYCLE - phase + 14.77);

  return { name, icon, phase, fraction, daysToFull: Math.round(daysToFull) };
}

// ─── 1. Wave Observations (Open-Meteo Marine current) ───────────────────────
async function loadBuoy() {
  try {
    // NDBC realtime data requires a CORS proxy which is unreliable in browsers.
    // Use Open-Meteo Marine API (CORS-enabled) for current wave observations.
    const currentVars = 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period';
    const hourlyVars  = 'sea_surface_temperature';
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT()}&longitude=${LNG()}`
      + `&current=${currentVars}&hourly=${hourlyVars}`
      + `&length_unit=imperial&timezone=America%2FLos_Angeles&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const c = d.current;
    const wvhtFt = c.wave_height?.toFixed(1) ?? '—';
    const dpd    = c.wave_period?.toFixed(0) ?? '—';
    const mwd    = c.wave_direction ?? null;
    const dirStr = mwd !== null ? degToCompass(mwd) : '—';
    const swHt   = c.swell_wave_height?.toFixed(1) ?? '—';
    const swPer  = c.swell_wave_period?.toFixed(0) ?? '—';
    const swDir  = c.swell_wave_direction ?? null;

    // Get current hour SST from hourly
    const now = new Date();
    const hours = d.hourly.time;
    let sstC = null;
    for (let i = 0; i < hours.length; i++) {
      if (new Date(hours[i]) <= now) sstC = d.hourly.sea_surface_temperature[i];
    }
    const sstF = sstC !== null && sstC !== undefined ? (sstC * 9/5 + 32).toFixed(0) : '—';

    setHTML('buoy-body', `
      <div class="stat-row">
        <span class="stat-value" style="color:#00d4aa">${wvhtFt}</span>
        ${wvhtFt !== '—' ? '<span class="stat-unit">ft</span>' : ''}
      </div>
      <div class="stat-label">Significant Wave Height (model)</div>
      <div class="stats-grid">
        <div class="stat-cell">
          <div class="label">Period</div>
          <div class="value">${dpd}<span style="font-size:12px;color:var(--text-muted)">s</span></div>
        </div>
        <div class="stat-cell">
          <div class="label">Swell</div>
          <div class="value">${swHt}<span style="font-size:12px;color:var(--text-muted)">ft</span></div>
          <div class="sub">${swPer}s · ${swDir !== null ? degToCompass(swDir) : '—'}</div>
        </div>
        <div class="stat-cell">
          <div class="label">Direction</div>
          <div class="value small">${dirStr}</div>
          <div class="sub">${mwd !== null ? mwd + '°' : ''}</div>
        </div>
        <div class="stat-cell">
          <div class="label">Water Temp</div>
          <div class="value">${sstF}<span style="font-size:12px;color:var(--text-muted)">${sstF !== '—' ? '°F' : ''}</span></div>
          <div class="sub">${sstC !== null && sstC !== undefined ? sstC.toFixed(1) + '°C' : ''}</div>
        </div>
      </div>
      <div class="buoy-source">Open-Meteo Marine · Monterey Bay · model data</div>
    `);
  } catch (e) {
    setHTML('buoy-body', errorHTML('Wave data unavailable: ' + e.message));
  }
}

// ─── 2. Open-Meteo Marine (Swell) ─────────────────────────────────────────────
async function loadSwell() {
  try {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT()}&longitude=${LNG()}`
      + `&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction`
      + `&wind_speed_unit=kn&length_unit=imperial&timezone=America%2FLos_Angeles&forecast_days=2&models=best_match`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    // Find current hour index
    const now = new Date();
    const hours = d.hourly.time;
    let idx = 0;
    for (let i = 0; i < hours.length; i++) {
      if (new Date(hours[i]) <= now) idx = i;
    }

    const wvHt   = d.hourly.wave_height[idx];
    const wvPer  = d.hourly.wave_period[idx];
    const wvDir  = d.hourly.wave_direction[idx];
    const swHt   = d.hourly.swell_wave_height[idx];
    const swPer  = d.hourly.swell_wave_period[idx];
    const swDir  = d.hourly.swell_wave_direction[idx];

    const dirStr = degToCompass(wvDir);
    const swDirStr = degToCompass(swDir);

    // Next 6 hours forecast
    let forecastRows = '';
    for (let i = idx + 1; i <= idx + 6 && i < hours.length; i++) {
      const t = new Date(hours[i]);
      const h = fmtTime(t).replace(':00', '');
      forecastRows += `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:11px;color:var(--text-muted);width:60px">${h}</span>
          <span style="font-size:13px;color:var(--text-primary)">${d.hourly.wave_height[i]?.toFixed(1) ?? '—'} ft</span>
          <span style="font-size:11px;color:var(--text-muted)">${d.hourly.wave_period[i]?.toFixed(0) ?? '—'}s</span>
          <span style="font-size:11px;color:var(--text-muted)">${degToCompass(d.hourly.wave_direction[i])}</span>
        </div>`;
    }

    setHTML('swell-body', `
      <div class="swell-compass">
        <div class="compass-rose" title="${wvDir}°">
          <span style="display:inline-block;transform:rotate(${wvDir + 180}deg);font-size:22px">↑</span>
        </div>
        <div>
          <div class="stat-row">
            <span class="stat-value" style="color:#1e90ff">${wvHt?.toFixed(1) ?? '—'}</span>
            <span class="stat-unit">ft</span>
          </div>
          <div class="stat-label">${wvPer?.toFixed(0) ?? '—'}s period · from ${dirStr} (${wvDir}°)</div>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-cell">
          <div class="label">Swell Height</div>
          <div class="value">${swHt?.toFixed(1) ?? '—'}<span style="font-size:12px;color:var(--text-muted)">ft</span></div>
        </div>
        <div class="stat-cell">
          <div class="label">Swell Period</div>
          <div class="value">${swPer?.toFixed(0) ?? '—'}<span style="font-size:12px;color:var(--text-muted)">s</span></div>
          <div class="sub">from ${swDirStr}</div>
        </div>
      </div>
      <div class="divider"></div>
      <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Next 6 Hours</div>
      ${forecastRows}
    `);
  } catch (e) {
    setHTML('swell-body', errorHTML('Swell data unavailable: ' + e.message));
  }
}

// ─── 3. Open-Meteo Weather (Wind) ─────────────────────────────────────────────
async function loadWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT()}&longitude=${LNG()}`
      + `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m`
      + `&wind_speed_unit=kn&timezone=America%2FLos_Angeles&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const now = new Date();
    const hours = d.hourly.time;
    let idx = 0;
    for (let i = 0; i < hours.length; i++) {
      if (new Date(hours[i]) <= now) idx = i;
    }

    renderWind(d.hourly.wind_speed_10m[idx], d.hourly.wind_gusts_10m[idx], d.hourly.wind_direction_10m[idx]);
  } catch (e) {
    setHTML('wind-body', errorHTML('Wind data unavailable: ' + e.message));
  }
}

function renderWind(speedKts, gustKts, dir) {
  const [cls, desc] = windClass(speedKts);
  const dirStr = degToCompass(dir);

  // Wind badge
  const badgeColors = {
    'wind-calm':   ['#00c853', 'rgba(0,200,83,0.15)'],
    'wind-light':  ['#69f0ae', 'rgba(105,240,174,0.15)'],
    'wind-mod':    ['#ffeb3b', 'rgba(255,235,59,0.15)'],
    'wind-fresh':  ['#ff9800', 'rgba(255,152,0,0.15)'],
    'wind-strong': ['#f44336', 'rgba(244,67,54,0.15)'],
    'wind-gale':   ['#b71c1c', 'rgba(183,28,28,0.15)'],
  };
  const [bc, bb] = badgeColors[cls];
  setBadge('wind-badge', desc.toUpperCase(), bc, bb);

  setHTML('wind-body', `
    <div class="wind-dir-display">
      <div class="wind-arrow-circle">
        <span class="wind-arrow" style="transform:rotate(${dir + 180}deg)">↑</span>
      </div>
      <div class="wind-info">
        <div class="speed-row">
          <span class="speed ${cls}">${speedKts?.toFixed(0) ?? '—'}</span>
          <span class="unit">kts</span>
        </div>
        <div class="desc">from ${dirStr} (${dir}°) · Gusts ${gustKts?.toFixed(0) ?? '—'} kts</div>
      </div>
    </div>
    <div class="stats-grid-3">
      <div class="stat-cell">
        <div class="label">Speed</div>
        <div class="value small ${cls}">${speedKts?.toFixed(0) ?? '—'} kts</div>
        <div class="sub">${(speedKts * 1.15078)?.toFixed(0)} mph</div>
      </div>
      <div class="stat-cell">
        <div class="label">Gusts</div>
        <div class="value small">${gustKts?.toFixed(0) ?? '—'} kts</div>
      </div>
      <div class="stat-cell">
        <div class="label">From</div>
        <div class="value small">${dirStr}</div>
        <div class="sub">${dir}°</div>
      </div>
    </div>
  `);
}


// ─── 4. NOAA Tides ────────────────────────────────────────────────────────────
async function loadTides() {
  try {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
      + `?begin_date=${fmtDate(today)}&end_date=${fmtDate(tomorrow)}&station=${NOAA_STATION()}`
      + `&datum=MLLW&time_zone=lst_ldt&units=english&application=web_services&format=json`;

    // Fetch hourly curve data and hi/lo events in parallel
    const [hourlyRes, hiloRes] = await Promise.all([
      fetch(base + '&product=predictions&interval=h'),
      fetch(base + '&product=predictions&interval=hilo'),
    ]);
    if (!hourlyRes.ok || !hiloRes.ok) throw new Error('HTTP error');
    const [hourlyData, hiloData] = await Promise.all([hourlyRes.json(), hiloRes.json()]);
    if (hourlyData.error) throw new Error(hourlyData.error.message);

    const hourly = hourlyData.predictions.map(p => ({ t: new Date(p.t), v: parseFloat(p.v) }));
    const events = hiloData.predictions.map(p => ({ t: new Date(p.t), v: parseFloat(p.v), type: p.type }));
    const now = new Date();

    // ── SVG line chart ──────────────────────────────────────────────────────
    const W = 320, H = 110, PL = 30, PR = 8, PT = 12, PB = 20;
    const chartW = W - PL - PR, chartH = H - PT - PB;

    // Window: 6 hours before now to 18 hours after (24hr total)
    const tStart = new Date(now.getTime() - 6 * 3600000);
    const tEnd   = new Date(now.getTime() + 18 * 3600000);

    const visible = hourly.filter(p => p.t >= tStart && p.t <= tEnd);
    if (visible.length < 2) throw new Error('Not enough data');

    const allVals = visible.map(p => p.v);
    const minV = Math.min(...allVals) - 0.3;
    const maxV = Math.max(...allVals) + 0.3;
    const tRange = tEnd - tStart;

    const tx = t => PL + ((t - tStart) / tRange) * chartW;
    const ty = v => PT + (1 - (v - minV) / (maxV - minV)) * chartH;

    // Build smooth SVG path using cubic bezier
    const pts = visible.map(p => [tx(p.t), ty(p.v)]);
    let pathD = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const cpx = (pts[i-1][0] + pts[i][0]) / 2;
      pathD += ` C ${cpx.toFixed(1)},${pts[i-1][1].toFixed(1)} ${cpx.toFixed(1)},${pts[i][1].toFixed(1)} ${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
    }

    // Fill area under curve
    const fillD = pathD
      + ` L ${pts[pts.length-1][0].toFixed(1)},${(PT + chartH).toFixed(1)}`
      + ` L ${pts[0][0].toFixed(1)},${(PT + chartH).toFixed(1)} Z`;

    // "Now" marker
    const nowX = tx(now).toFixed(1);
    const nowV = (() => {
      // Interpolate current level from hourly data
      for (let i = 1; i < visible.length; i++) {
        if (visible[i].t >= now) {
          const frac = (now - visible[i-1].t) / (visible[i].t - visible[i-1].t);
          return visible[i-1].v + frac * (visible[i].v - visible[i-1].v);
        }
      }
      return visible[visible.length-1].v;
    })();
    const nowY = ty(nowV).toFixed(1);

    // Hi/Lo markers within window
    const visibleEvents = events.filter(e => e.t >= tStart && e.t <= tEnd);
    const eventMarkers = visibleEvents.map(e => {
      const ex = tx(e.t).toFixed(1);
      const ey = ty(e.v).toFixed(1);
      const isHigh = e.type === 'H';
      const color = isHigh ? '#9b6dff' : '#1e90ff';
      const labelY = isHigh ? (parseFloat(ey) - 8).toFixed(1) : (parseFloat(ey) + 14).toFixed(1);
      return `
        <circle cx="${ex}" cy="${ey}" r="3.5" fill="${color}" stroke="#0f1f3d" stroke-width="1.5"/>
        <text x="${ex}" y="${labelY}" text-anchor="middle" font-size="8" fill="${color}" font-weight="600">${e.v.toFixed(1)}ft</text>`;
    }).join('');

    // X-axis hour labels (every 6h)
    let xLabels = '';
    for (let h = 0; h <= 24; h += 6) {
      const t = new Date(tStart.getTime() + h * 3600000);
      const x = tx(t).toFixed(1);
      const lbl = t.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' ', '');
      xLabels += `<text x="${x}" y="${(H - 4).toFixed(1)}" text-anchor="middle" font-size="8" fill="#4a7a96">${lbl}</text>`;
    }

    // Y-axis labels
    const yMid = (minV + maxV) / 2;
    const yLabels = [minV + 0.3, yMid, maxV - 0.3].map(v => {
      const y = ty(v).toFixed(1);
      return `<text x="${(PL - 3).toFixed(1)}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="8" fill="#4a7a96">${v.toFixed(1)}</text>`;
    }).join('');

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        <defs>
          <linearGradient id="tideFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1e90ff" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#1e90ff" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <!-- fill -->
        <path d="${fillD}" fill="url(#tideFill)"/>
        <!-- curve -->
        <path d="${pathD}" fill="none" stroke="#1e90ff" stroke-width="2" stroke-linejoin="round"/>
        <!-- now line -->
        <line x1="${nowX}" y1="${PT}" x2="${nowX}" y2="${PT + chartH}" stroke="#00d4aa" stroke-width="1.5" stroke-dasharray="3,3"/>
        <!-- now dot -->
        <circle cx="${nowX}" cy="${nowY}" r="4" fill="#00d4aa" stroke="#0f1f3d" stroke-width="1.5"/>
        <!-- now label -->
        <text x="${nowX}" y="${(parseFloat(nowY) - 8).toFixed(1)}" text-anchor="middle" font-size="8" fill="#00d4aa" font-weight="700">${nowV.toFixed(1)}ft</text>
        <!-- hi/lo markers -->
        ${eventMarkers}
        <!-- x labels -->
        ${xLabels}
        <!-- y labels -->
        ${yLabels}
      </svg>`;

    // Today's schedule
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
    const todayEvents = events.filter(e => e.t.toISOString().slice(0,10) === today.toISOString().slice(0,10)
      || e.t.toLocaleDateString() === today.toLocaleDateString());
    const scheduleHTML = events
      .filter(e => {
        const d = e.t;
        return d.getFullYear() === today.getFullYear()
          && d.getMonth() === today.getMonth()
          && d.getDate() === today.getDate();
      })
      .map(e => {
        const isHigh = e.type === 'H';
        return `
          <div class="tide-event">
            <span class="type-badge ${isHigh ? 'high' : 'low'}">${isHigh ? 'High' : 'Low'}</span>
            <span class="time">${fmtTime(e.t)}</span>
            <span class="height">${e.v.toFixed(2)} ft</span>
          </div>`;
      }).join('');

    const trend = (() => {
      const next = events.find(e => e.t > now);
      if (!next) return '';
      return next.type === 'H' ? '↑ Rising' : '↓ Falling';
    })();

    setHTML('tides-body', `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:22px;font-weight:700;color:#1e90ff">${nowV.toFixed(2)}<span style="font-size:12px;color:var(--text-muted)"> ft</span></span>
        <span style="font-size:12px;color:var(--text-secondary)">${trend}</span>
      </div>
      ${svg}
      <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin:10px 0 5px">Today's Schedule</div>
      <div class="tide-schedule">${scheduleHTML || '<div class="error-msg">No events today</div>'}</div>
      <div class="buoy-source" style="margin-top:6px">NOAA Station ${NOAA_STATION()} · MLLW</div>
    `);
  } catch (e) {
    setHTML('tides-body', errorHTML('Tide data unavailable: ' + e.message));
  }
}


// ─── 6 & 7. NWS Marine Forecast + Rip Current ────────────────────────────────
async function loadNWS() {
  try {
    // Get the gridpoint for our location
    const ptRes = await fetch(`https://api.weather.gov/points/${LAT()},${LNG()}`);
    if (!ptRes.ok) throw new Error(`Points API: HTTP ${ptRes.ok}`);
    const ptData = await ptRes.json();

    // Marine forecast — use marine zone PZZ535 (Monterey Bay)
    loadMarineForecast();

    // Rip current — use beach forecast
    loadRipCurrent(ptData);
  } catch (e) {
    loadMarineForecast();
    loadRipCurrent(null);
  }
}

async function loadMarineForecast() {
  try {
    // Step 1: Get the latest CWF product from MTR (San Francisco/Monterey office)
    const listRes = await fetch('https://api.weather.gov/products/types/CWF/locations/MTR', {
      headers: { 'User-Agent': 'SurfConditionsApp/1.0', 'Accept': 'application/geo+json' }
    });
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
    const listData = await listRes.json();
    const firstID = listData['@graph']?.[0]?.id;
    if (!firstID) throw new Error('No CWF products found');

    // Step 2: Fetch the product text
    const prodRes = await fetch(`https://api.weather.gov/products/${firstID}`, {
      headers: { 'User-Agent': 'SurfConditionsApp/1.0' }
    });
    if (!prodRes.ok) throw new Error(`HTTP ${prodRes.status}`);
    const prodData = await prodRes.json();
    const fullText = prodData.productText;
    if (!fullText) throw new Error('No product text');

    // Step 3: Extract the active location's marine zone section
    const zone = MARINE_ZONE();
    const zoneIdx = fullText.indexOf(zone + '-');
    if (zoneIdx === -1) throw new Error(`${zone} zone not found in CWF`);

    const afterZone = fullText.slice(zoneIdx);
    const sectionLines = afterZone.split('\n');
    const body = [];
    for (const line of sectionLines) {
      if (line.startsWith('$$')) break;
      body.push(line);
    }
    // Drop first 3 lines (zone ID, zone name, issuance time)
    const forecastText = body.slice(3).join('\n').trim();
    if (!forecastText) throw new Error('Empty forecast section');

    // Split into period blocks by lines starting with "."
    const blocks = forecastText.split(/\n(?=\.)/).filter(b => b.trim());
    const html = blocks.slice(0, 4).map(block => {
      const raw = block.trim().replace(/^\./, '');
      // CWF format: "TONIGHT...forecast text" or "SAT...forecast text"
      const dotdot = raw.indexOf('...');
      let title, detail;
      if (dotdot !== -1) {
        title = raw.slice(0, dotdot).trim();
        detail = raw.slice(dotdot + 3).replace(/\n/g, ' ').trim();
      } else {
        title = raw.split('\n')[0].trim();
        detail = raw.split('\n').slice(1).join(' ').trim();
      }
      return `
        <div style="margin-bottom:10px">
          <div style="font-size:11px;font-weight:600;color:var(--accent-blue);margin-bottom:3px">${title}</div>
          <div class="forecast-text">${detail}</div>
        </div>`;
    }).join('');

    setHTML('marine-body', html || errorHTML('No forecast periods available'));
  } catch (e) {
    setHTML('marine-body', errorHTML('Marine forecast unavailable: ' + e.message));
  }
}

async function loadRipCurrent(ptData) {
  try {
    let forecastUrl = null;

    if (ptData) {
      forecastUrl = ptData.properties?.forecast;
    }

    if (!forecastUrl) {
      // Fallback: use the grid forecast directly
      const office = 'MTR';
      const gx = 92, gy = 81;
      forecastUrl = `https://api.weather.gov/gridpoints/${office}/${gx},${gy}/forecast`;
    }

    const res = await fetch(forecastUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const periods = d.properties.periods;
    let ripText = null;
    let ripLevel = 'low';

    for (const p of periods) {
      const detail = (p.detailedForecast || '').toLowerCase();
      if (detail.includes('rip current')) {
        ripText = p.detailedForecast;
        if (detail.includes('high') || detail.includes('dangerous')) ripLevel = 'high';
        else if (detail.includes('moderate') || detail.includes('likely')) ripLevel = 'moderate';
        break;
      }
    }

    if (!ripText) {
      // Check hazards
      ripText = 'No rip current advisories in effect for Monterey Bay.';
    }

    const levelLabel = ripLevel.charAt(0).toUpperCase() + ripLevel.slice(1);
    setBadge('rip-badge', levelLabel.toUpperCase(),
      ripLevel === 'low' ? '#00c853' : ripLevel === 'moderate' ? '#ffeb3b' : '#f44336',
      ripLevel === 'low' ? 'rgba(0,200,83,0.15)' : ripLevel === 'moderate' ? 'rgba(255,235,59,0.15)' : 'rgba(244,67,54,0.15)');

    setHTML('rip-body', `
      <div class="rip-indicator">
        <div class="rip-level ${ripLevel}">${levelLabel}</div>
        <div class="rip-desc">${ripText.substring(0, 200)}${ripText.length > 200 ? '…' : ''}</div>
      </div>
      <div class="buoy-source" style="margin-top:8px">Source: NWS · National Weather Service</div>
    `);
  } catch (e) {
    setHTML('rip-body', errorHTML('Rip current data unavailable: ' + e.message));
  }
}

// ─── Refresh all ──────────────────────────────────────────────────────────────
async function refreshAll() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  setHTML('lastUpdated', 'Updating…');

  await Promise.allSettled([
    loadBuoy(),
    loadSwell(),
    loadWeather(),
    loadTides(),
    loadNWS(),
  ]);

  btn.classList.remove('spinning');
  const now = new Date();
  setHTML('lastUpdated', `Updated ${fmtTime(now)}`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// Sync selector UI and subtitle to the saved/active location before first load
document.querySelectorAll('.loc-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.id === ACTIVE.id);
});
const _sub = document.getElementById('location-subtitle');
if (_sub) _sub.textContent = `${ACTIVE.name} · ${ACTIVE.lat.toFixed(1)}°N ${Math.abs(ACTIVE.lng).toFixed(1)}°W`;

refreshAll();

// Auto-refresh every 10 minutes
setInterval(refreshAll, 10 * 60 * 1000);
