// ─── Config ───────────────────────────────────────────────────────────────────
const LAT = 36.6;
const LNG = -121.9;
const NOAA_STATION = '9413450';
const BUOY_ID = '46240';

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

// ─── 1. NOAA Buoy 46240 (Point Sur) ──────────────────────────────────────────
async function loadBuoy() {
  try {
    // Use a CORS proxy to fetch NDBC text data
    const url = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://www.ndbc.noaa.gov/data/realtime2/${BUOY_ID}.txt`)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.trim().split('\n');

    // Line 0 = header names, line 1 = units, line 2+ = data
    // Find first data line that isn't MM (missing)
    let data = null;
    for (let i = 2; i < Math.min(10, lines.length); i++) {
      const cols = lines[i].trim().split(/\s+/);
      if (cols[8] !== 'MM') { data = cols; break; }
    }
    if (!data) throw new Error('No valid buoy data');

    // Header: #YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
    // Index:   0   1  2  3  4   5    6    7    8     9    10   11   12    13    14    15   16   17   18
    const wvht = parseFloat(data[8]);   // wave height meters
    const dpd  = parseFloat(data[9]);   // dominant period seconds
    const apd  = parseFloat(data[10]);  // avg period
    const mwd  = parseInt(data[11]);    // mean wave direction
    const wtmp = parseFloat(data[14]);  // water temp °C
    const atmp = parseFloat(data[13]);  // air temp °C

    const wvhtFt = isNaN(wvht) ? 'N/A' : metersToFeet(wvht).toFixed(1);
    const wtmpF  = isNaN(wtmp) ? 'N/A' : (wtmp * 9/5 + 32).toFixed(0);
    const atmpF  = isNaN(atmp) ? 'N/A' : (atmp * 9/5 + 32).toFixed(0);
    const dirStr = isNaN(mwd) ? '—' : degToCompass(mwd);

    setHTML('buoy-body', `
      <div class="stat-row">
        <span class="stat-value" style="color:#00d4aa">${wvhtFt}</span>
        ${wvhtFt !== 'N/A' ? '<span class="stat-unit">ft</span>' : ''}
      </div>
      <div class="stat-label">Significant Wave Height (measured)</div>
      <div class="stats-grid">
        <div class="stat-cell">
          <div class="label">Period</div>
          <div class="value">${isNaN(dpd) ? '—' : dpd.toFixed(0)}<span style="font-size:12px;color:var(--text-muted)">s</span></div>
          <div class="sub">dominant</div>
        </div>
        <div class="stat-cell">
          <div class="label">Avg Period</div>
          <div class="value">${isNaN(apd) ? '—' : apd.toFixed(1)}<span style="font-size:12px;color:var(--text-muted)">s</span></div>
        </div>
        <div class="stat-cell">
          <div class="label">Direction</div>
          <div class="value small">${dirStr}</div>
          <div class="sub">${isNaN(mwd) ? '' : mwd + '°'}</div>
        </div>
        <div class="stat-cell">
          <div class="label">Water Temp</div>
          <div class="value">${wtmpF}<span style="font-size:12px;color:var(--text-muted)">${wtmpF === 'N/A' ? '' : '°F'}</span></div>
          <div class="sub">${isNaN(wtmp) ? '' : wtmp.toFixed(1) + '°C'}</div>
        </div>
      </div>
      <div class="buoy-source">46240 · Point Sur · ~10nm offshore · ${atmpF === 'N/A' ? '' : 'Air ' + atmpF + '°F'}</div>
    `);
  } catch (e) {
    setHTML('buoy-body', errorHTML('Buoy data unavailable: ' + e.message));
  }
}

// ─── 2. Open-Meteo Marine (Swell) ─────────────────────────────────────────────
async function loadSwell() {
  try {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LNG}`
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
          <span style="display:inline-block;transform:rotate(${wvDir}deg);font-size:22px">↑</span>
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

// ─── 3. Open-Meteo Weather (Wind + UV) ────────────────────────────────────────
async function loadWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}`
      + `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index`
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

    const windSpd  = d.hourly.wind_speed_10m[idx];
    const windGust = d.hourly.wind_gusts_10m[idx];
    const windDir  = d.hourly.wind_direction_10m[idx];
    const uv       = d.hourly.uv_index[idx] ?? 0;

    renderWind(windSpd, windGust, windDir);
    renderUV(uv);
  } catch (e) {
    setHTML('wind-body', errorHTML('Wind data unavailable: ' + e.message));
    setHTML('uv-body', errorHTML('UV data unavailable'));
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
        <span class="wind-arrow" style="transform:rotate(${dir}deg)">↑</span>
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

function renderUV(uv) {
  const cat = uvCategory(uv);
  const pct = Math.min(uv / 11, 1) * 100;
  setBadge('uv-badge', cat.label.toUpperCase(), cat.color, cat.bg);
  setHTML('uv-body', `
    <div class="stat-row">
      <span class="stat-value" style="color:${cat.color}">${uv?.toFixed(1) ?? '—'}</span>
    </div>
    <div class="stat-label">${cat.label} · UV Index</div>
    <div class="uv-bar-wrap">
      <div class="uv-bar-track">
        <div class="uv-bar-dot" style="left:${pct}%"></div>
      </div>
      <div class="uv-labels"><span>0</span><span>3</span><span>6</span><span>8</span><span>11+</span></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
      ${uv < 3 ? 'No protection needed' : uv < 6 ? 'Sunscreen recommended' : uv < 8 ? 'Sunscreen & hat required' : 'Extra protection essential'}
    </div>
  `);
}

// ─── 4. NOAA Tides ────────────────────────────────────────────────────────────
async function loadTides() {
  try {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;

    // Fetch predictions for today + tomorrow
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const endStr = `${tomorrow.getFullYear()}${pad(tomorrow.getMonth()+1)}${pad(tomorrow.getDate())}`;

    const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
      + `?begin_date=${dateStr}&end_date=${endStr}&station=${NOAA_STATION}`
      + `&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&application=web_services&format=json`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);

    const predictions = d.predictions;
    const now = new Date();

    // Also fetch current water level
    const lvlUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
      + `?date=latest&station=${NOAA_STATION}`
      + `&product=water_level&datum=MLLW&time_zone=lst_ldt&units=english&application=web_services&format=json`;
    let currentLevel = null;
    try {
      const lvlRes = await fetch(lvlUrl);
      const lvlData = await lvlRes.json();
      if (lvlData.data && lvlData.data.length > 0) {
        currentLevel = parseFloat(lvlData.data[lvlData.data.length - 1].v);
      }
    } catch (_) {}

    // Find next high/low
    const upcoming = predictions.filter(p => new Date(p.t) > now).slice(0, 4);
    const prev = predictions.filter(p => new Date(p.t) <= now);
    const lastPrev = prev[prev.length - 1];
    const nextEvent = upcoming[0];

    // Determine rising/falling
    let trend = '—';
    if (lastPrev && nextEvent) {
      trend = parseFloat(nextEvent.v) > parseFloat(lastPrev.v) ? '↑ Rising' : '↓ Falling';
    }

    // Tide bar: interpolate between surrounding events
    let pct = 50;
    if (lastPrev && nextEvent) {
      const lo = Math.min(parseFloat(lastPrev.v), parseFloat(nextEvent.v));
      const hi = Math.max(parseFloat(lastPrev.v), parseFloat(nextEvent.v));
      const range = hi - lo || 1;
      if (currentLevel !== null) {
        pct = Math.max(0, Math.min(100, ((currentLevel - lo) / range) * 100));
      }
    }

    // All events today
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
    const todayEvents = predictions.filter(p => p.t.startsWith(todayStr));

    const scheduleHTML = todayEvents.map(p => {
      const isHigh = p.type === 'H';
      const timeStr = fmtTime(new Date(p.t));
      const ht = parseFloat(p.v).toFixed(2);
      return `
        <div class="tide-event">
          <span class="type-badge ${isHigh ? 'high' : 'low'}">${isHigh ? 'High' : 'Low'}</span>
          <span class="time">${timeStr}</span>
          <span class="height">${ht} ft</span>
        </div>`;
    }).join('');

    const isRising = trend.includes('↑');
    const currentDisplay = currentLevel !== null
      ? `<span class="height">${currentLevel.toFixed(2)} ft</span><span class="status-text">${trend}</span>`
      : `<span class="status-text">${trend}</span>`;

    setHTML('tides-body', `
      <div class="tide-status">
        <div class="tide-arrow">${isRising ? '↑' : '↓'}</div>
        <div class="tide-now">
          ${currentDisplay}
        </div>
      </div>
      <div class="tide-bar-wrap">
        <div class="tide-bar-track">
          <div class="tide-bar-fill" style="width:${pct}%"></div>
          <div class="tide-bar-dot" style="left:${pct}%"></div>
        </div>
        <div class="tide-bar-labels">
          <span>Low</span>
          <span>High</span>
        </div>
      </div>
      <div class="divider"></div>
      <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Today's Schedule</div>
      <div class="tide-schedule">${scheduleHTML || '<div class="error-msg">No tide data for today</div>'}</div>
      <div class="buoy-source">Monterey Harbor · NOAA Station ${NOAA_STATION} · MLLW datum</div>
    `);
  } catch (e) {
    setHTML('tides-body', errorHTML('Tide data unavailable: ' + e.message));
  }
}

// ─── 5. Sunrise / Sunset ──────────────────────────────────────────────────────
async function loadSunMoon() {
  try {
    const url = `https://api.sunrise-sunset.org/json?lat=${LAT}&lng=${LNG}&formatted=0`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const sunrise = new Date(d.results.sunrise);
    const sunset  = new Date(d.results.sunset);
    const solar   = new Date(d.results.solar_noon);
    const daylen  = d.results.day_length; // seconds

    const hours = Math.floor(daylen / 3600);
    const mins  = Math.floor((daylen % 3600) / 60);

    const moon = getMoonPhase();

    setHTML('sunmoon-body', `
      <div class="sun-moon-grid">
        <div class="sun-section">
          <div class="section-label">☀️ Sun</div>
          <div class="sun-times">
            <div class="time-row">
              <span class="lbl">Sunrise</span>
              <span class="val">${fmtTime(sunrise)}</span>
            </div>
            <div class="time-row">
              <span class="lbl">Solar Noon</span>
              <span class="val">${fmtTime(solar)}</span>
            </div>
            <div class="time-row">
              <span class="lbl">Sunset</span>
              <span class="val">${fmtTime(sunset)}</span>
            </div>
            <div class="time-row" style="margin-top:4px">
              <span class="lbl">Day length</span>
              <span class="val" style="font-size:11px">${hours}h ${mins}m</span>
            </div>
          </div>
        </div>
        <div class="moon-section">
          <div class="section-label">🌙 Moon</div>
          <div class="moon-info">
            <div class="moon-phase-icon">${moon.icon}</div>
            <div class="moon-phase-name">${moon.name}</div>
            <div style="font-size:10px;color:var(--text-muted);text-align:center;margin-top:4px">
              ${moon.daysToFull > 0 ? moon.daysToFull + 'd to full' : 'Full moon today'}
            </div>
          </div>
        </div>
      </div>
    `);
  } catch (e) {
    // Fall back to moon-only if sunrise API fails
    const moon = getMoonPhase();
    setHTML('sunmoon-body', `
      <div class="sun-moon-grid">
        <div class="sun-section">
          <div class="error-msg">Sun times unavailable</div>
        </div>
        <div class="moon-section">
          <div class="section-label">🌙 Moon</div>
          <div class="moon-info">
            <div class="moon-phase-icon">${moon.icon}</div>
            <div class="moon-phase-name">${moon.name}</div>
          </div>
        </div>
      </div>
    `);
  }
}

// ─── 6 & 7. NWS Marine Forecast + Rip Current ────────────────────────────────
async function loadNWS() {
  try {
    // Get the gridpoint for our location
    const ptRes = await fetch(`https://api.weather.gov/points/${LAT},${LNG}`);
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
    // PZZ535 = Monterey Bay marine zone
    const url = `https://api.weather.gov/zones/forecast/PZZ535/forecast`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const periods = d.properties.periods.slice(0, 3);
    const html = periods.map(p => `
      <div style="margin-bottom:10px">
        <div style="font-size:11px;font-weight:600;color:var(--accent-blue);margin-bottom:3px">${p.name}</div>
        <div class="forecast-text">${p.detailedForecast || p.body || '—'}</div>
      </div>
    `).join('');

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
    loadSunMoon(),
    loadNWS(),
  ]);

  btn.classList.remove('spinning');
  const now = new Date();
  setHTML('lastUpdated', `Updated ${fmtTime(now)}`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
refreshAll();

// Auto-refresh every 10 minutes
setInterval(refreshAll, 10 * 60 * 1000);
