// ─── Config ───────────────────────────────────────────────────────────────────
const WORKER_URL = 'https://surf-alerts.dbales1210.workers.dev';
const VAPID_PUBLIC_KEY = 'BFBSS-y5LgAuMfFCW2Vht2wYdxJBSNvQ-O9pHy98Ink35jeBCfxsaj0CF0xXcr8eXG3OFHYgFUP3IX-bsFh_1Oc';

// ─── Service Worker + Push Notifications ──────────────────────────────────────
let _swReg = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(reg => {
      _swReg = reg;
      if ('PushManager' in window) {
        document.getElementById('alertBtn').style.display = '';
        updateAlertBtn(reg);
      }
    })
    .catch(() => {});
}

function urlBase64ToUint8Array(base64String) {
  const pad = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function updateAlertBtn(reg) {
  const btn = document.getElementById('alertBtn');
  if (!btn) return;
  const sub = await reg.pushManager.getSubscription();
  btn.textContent = sub ? '🔔' : '🔕';
  btn.title = sub ? 'Alerts ON — tap to disable' : 'Alerts OFF — tap to enable';
}

async function toggleAlerts() {
  if (!_swReg) return;
  const existing = await _swReg.pushManager.getSubscription();

  if (existing) {
    await existing.unsubscribe();
    await fetch(`${WORKER_URL}/unsubscribe`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: existing.endpoint }),
    }).catch(() => {});
    updateAlertBtn(_swReg);
    return;
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    alert('Notification permission denied. Enable it in Chrome settings.');
    return;
  }

  try {
    const sub = await _swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    await fetch(`${WORKER_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
    updateAlertBtn(_swReg);
  } catch (e) {
    alert('Failed to enable alerts: ' + e.message);
  }
}

// ─── Spot Storage ─────────────────────────────────────────────────────────────
// Spot shape: { id, name, lat, lng, isUS, tideStation, marineZone, cwfOffice, forecastUrl }

let SAVED_SPOTS = [];
let ACTIVE = null;
let pendingSpots = []; // working copy while editor is open

function loadSpots() {
  try {
    const raw = localStorage.getItem('surf_spots_v2');
    SAVED_SPOTS = raw ? JSON.parse(raw) : [];
  } catch(e) { SAVED_SPOTS = []; }
}

function saveSpots() {
  localStorage.setItem('surf_spots_v2', JSON.stringify(SAVED_SPOTS));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// Convenience accessors (used throughout API functions)
function LAT()          { return ACTIVE?.lat; }
function LNG()          { return ACTIVE?.lng; }
function NOAA_STATION() { return ACTIVE?.tideStation; }
function MARINE_ZONE()  { return ACTIVE?.marineZone; }

// ─── US Coast Detection ───────────────────────────────────────────────────────
function isUSCoast(lat, lng) {
  // Continental US
  if (lat >= 24.0 && lat <= 49.5 && lng >= -125.5 && lng <= -66.0) return true;
  // Hawaii
  if (lat >= 18.5 && lat <= 22.5 && lng >= -161.0 && lng <= -154.5) return true;
  // Alaska
  if (lat >= 54.0 && lat <= 71.5 && lng >= -168.5 && lng <= -130.0) return true;
  // Puerto Rico
  if (lat >= 17.5 && lat <= 18.6 && lng >= -67.5 && lng <= -65.0) return true;
  return false;
}

// ─── NOAA Tide Station Detection ──────────────────────────────────────────────
async function findNearestTideStation(lat, lng) {
  try {
    const res = await fetch(
      `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json`
      + `?type=tidepredictions&units=english&lat=${lat}&lon=${lng}&radius=300`
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const stations = data.stations || [];
    if (!stations.length) return null;
    let nearest = null, minDist = Infinity;
    for (const s of stations) {
      const d = Math.hypot(s.lat - lat, s.lng - lng);
      if (d < minDist) { minDist = d; nearest = s; }
    }
    return nearest?.id || null;
  } catch(e) { return null; }
}

// ─── NWS Marine Zone + Office Detection ───────────────────────────────────────
async function findMarineZoneAndOffice(lat, lng) {
  let office = null, forecastUrl = null;

  // Points API — gives CWA office code and grid forecast URL
  try {
    const ptRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
    if (ptRes.ok) {
      const ptData = await ptRes.json();
      office = ptData.properties?.cwa || null;
      forecastUrl = ptData.properties?.forecast || null;
    }
  } catch(e) {}

  // Try offshore zone first, then coastal
  let zone = null;
  for (const type of ['offshore', 'coastal']) {
    if (zone) break;
    try {
      const r = await fetch(
        `https://api.weather.gov/zones?point=${lat.toFixed(4)},${lng.toFixed(4)}&type=${type}`
      );
      if (r.ok) {
        const d = await r.json();
        zone = d.features?.[0]?.properties?.id || null;
      }
    } catch(e) {}
  }

  return { zone, office, forecastUrl };
}

// ─── Nominatim Geocoding ──────────────────────────────────────────────────────
async function searchPlaces(query) {
  const url = `https://nominatim.openstreetmap.org/search`
    + `?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

function formatSpotName(result) {
  const parts = result.display_name.split(', ');
  // "Beach Name, City" or first 2 parts
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
  return parts[0];
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Onboarding / Spot Editor ─────────────────────────────────────────────────
let _searchResults = [];
let _searchTimer = null;
let _isEditMode = false;

function openSpotEditor(editMode) {
  _isEditMode = !!editMode;
  pendingSpots = [...SAVED_SPOTS];

  document.getElementById('onboarding-title').textContent = editMode ? 'Edit Spots' : "DB's Local";
  document.getElementById('onboarding-sub').textContent  = editMode
    ? 'Manage your local surf spots'
    : 'Add up to 4 of your local surf spots';
  document.getElementById('start-btn').textContent = editMode ? 'Save Changes →' : 'Start Surfing →';
  document.getElementById('start-btn').disabled = pendingSpots.length === 0;
  document.getElementById('spot-search').value = '';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-status').textContent = '';

  renderEditorSpots();
  document.getElementById('onboarding').style.display = 'flex';
}

function finishOnboarding() {
  if (pendingSpots.length === 0) return;
  SAVED_SPOTS = [...pendingSpots];
  saveSpots();

  // Keep active spot if it's still in saved spots, else use first
  if (!SAVED_SPOTS.find(s => s.id === ACTIVE?.id)) {
    ACTIVE = SAVED_SPOTS[0];
  }
  localStorage.setItem('surf_active_spot', ACTIVE.id);

  document.getElementById('onboarding').style.display = 'none';
  renderLocationPills();
  updateSubtitle();
  updateCardVisibility();
  refreshAll();
}

function onSearchInput(val) {
  clearTimeout(_searchTimer);
  const status  = document.getElementById('search-status');
  const results = document.getElementById('search-results');

  if (val.length < 2) {
    results.innerHTML = '';
    status.textContent = '';
    return;
  }

  status.textContent = 'Searching…';
  results.innerHTML = '';

  _searchTimer = setTimeout(async () => {
    try {
      const data = await searchPlaces(val);
      _searchResults = data;
      if (!data.length) {
        status.textContent = 'No results found';
        return;
      }
      status.textContent = '';
      if (pendingSpots.length >= 4) {
        status.textContent = 'Maximum 4 spots reached';
        return;
      }
      results.innerHTML = data.map((r, i) => `
        <button class="search-result-btn" onclick="addSpotFromResult(${i})">
          <span class="search-result-icon">📍</span>
          <span class="search-result-text">${escapeHtml(r.display_name.split(', ').slice(0, 3).join(', '))}</span>
        </button>
      `).join('');
    } catch(e) {
      status.textContent = 'Search error — check connection';
    }
  }, 350);
}

async function addSpotFromResult(idx) {
  const result = _searchResults[idx];
  if (!result || pendingSpots.length >= 4) return;

  const lat = parseFloat(result.lat);
  const lng = parseFloat(result.lon);
  const name = formatSpotName(result);

  // Show adding state
  document.getElementById('search-results').innerHTML =
    `<div class="search-adding"><span class="search-adding-spinner"></span> Detecting data sources for <strong>${escapeHtml(name)}</strong>…</div>`;
  document.getElementById('search-status').textContent = '';
  document.getElementById('spot-search').value = '';

  const usCoast = isUSCoast(lat, lng);
  let tideStation = null, marineZone = null, cwfOffice = null, forecastUrl = null;

  if (usCoast) {
    const [station, nws] = await Promise.all([
      findNearestTideStation(lat, lng),
      findMarineZoneAndOffice(lat, lng),
    ]);
    tideStation = station;
    marineZone  = nws.zone;
    cwfOffice   = nws.office;
    forecastUrl = nws.forecastUrl;
  }

  pendingSpots.push({ id: genId(), name, lat, lng, isUS: usCoast, tideStation, marineZone, cwfOffice, forecastUrl });

  document.getElementById('search-results').innerHTML = '';
  renderEditorSpots();
  document.getElementById('start-btn').disabled = false;
}

function removePendingSpot(i) {
  pendingSpots.splice(i, 1);
  renderEditorSpots();
  document.getElementById('start-btn').disabled = pendingSpots.length === 0;
}

function renderEditorSpots() {
  const section = document.getElementById('added-spots-section');
  const list    = document.getElementById('added-spots-list');

  if (!pendingSpots.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  const remaining = 4 - pendingSpots.length;
  const hint = remaining > 0
    ? `${remaining} more spot${remaining !== 1 ? 's' : ''} can be added`
    : 'Maximum 4 spots reached';

  list.innerHTML = pendingSpots.map((s, i) => `
    <div class="added-spot-item">
      <span class="added-spot-flag">${s.isUS ? '🇺🇸' : '🌍'}</span>
      <div class="added-spot-info">
        <span class="added-spot-name">${escapeHtml(s.name)}</span>
        <span class="added-spot-meta">${s.isUS
          ? (s.tideStation ? '✓ Tides' : '— No tides') + (s.marineZone ? ' · ✓ Forecast' : '')
          : 'Waves &amp; wind only'}</span>
      </div>
      <button class="remove-spot-btn" onclick="removePendingSpot(${i})">×</button>
    </div>
  `).join('') + `<div class="spots-hint">${hint}</div>`;
}

// ─── Location Pills ───────────────────────────────────────────────────────────
function renderLocationPills() {
  const container = document.getElementById('location-selector');
  if (!container) return;
  container.innerHTML = SAVED_SPOTS.map(s => `
    <button class="loc-btn${s.id === ACTIVE?.id ? ' active' : ''}"
            data-id="${s.id}"
            onclick="setLocation('${s.id}')">${escapeHtml(s.name)}</button>
  `).join('');
}

function setLocation(id) {
  const spot = SAVED_SPOTS.find(s => s.id === id);
  if (!spot) return;
  ACTIVE = spot;
  localStorage.setItem('surf_active_spot', id);
  renderLocationPills();
  updateSubtitle();
  updateCardVisibility();
  refreshAll();
}

function updateSubtitle() {
  const sub = document.getElementById('location-subtitle');
  if (!sub || !ACTIVE) return;
  const ns = ACTIVE.lat >= 0 ? 'N' : 'S';
  const ew = ACTIVE.lng  < 0 ? 'W' : 'E';
  sub.textContent = `${ACTIVE.name} · ${Math.abs(ACTIVE.lat).toFixed(1)}°${ns} ${Math.abs(ACTIVE.lng).toFixed(1)}°${ew}`;
}

function updateCardVisibility() {
  if (!ACTIVE) return;
  const hasTides  = ACTIVE.isUS && !!ACTIVE.tideStation;
  const hasMarine = ACTIVE.isUS && !!ACTIVE.marineZone && !!ACTIVE.cwfOffice;
  const hasRip    = ACTIVE.isUS;

  const tidesCard  = document.getElementById('card-tides');
  const marineCard = document.getElementById('card-marine');
  const ripCard    = document.getElementById('card-rip');

  if (tidesCard)  tidesCard.style.display  = hasTides  ? '' : 'none';
  if (marineCard) marineCard.style.display = hasMarine ? '' : 'none';
  if (ripCard)    ripCard.style.display    = hasRip    ? '' : 'none';

  if (hasTides) {
    const tidesTitle = document.querySelector('#card-tides .card-title');
    if (tidesTitle) tidesTitle.innerHTML = `<span class="icon">🌊</span> Tides · Station ${ACTIVE.tideStation}`;
  }
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
  const known = new Date('2000-01-06T18:14:00Z');
  const LUNAR_CYCLE = 29.530588853;
  const diff = (date - known) / (1000 * 60 * 60 * 24);
  const phase = ((diff % LUNAR_CYCLE) + LUNAR_CYCLE) % LUNAR_CYCLE;
  const fraction = phase / LUNAR_CYCLE;
  let name, icon;
  if (phase < 1.85)       { name = 'New Moon';        icon = '🌑'; }
  else if (phase < 5.54)  { name = 'Waxing Crescent'; icon = '🌒'; }
  else if (phase < 9.22)  { name = 'First Quarter';   icon = '🌓'; }
  else if (phase < 12.91) { name = 'Waxing Gibbous';  icon = '🌔'; }
  else if (phase < 16.61) { name = 'Full Moon';        icon = '🌕'; }
  else if (phase < 20.30) { name = 'Waning Gibbous';  icon = '🌖'; }
  else if (phase < 23.99) { name = 'Last Quarter';    icon = '🌗'; }
  else if (phase < 27.68) { name = 'Waning Crescent'; icon = '🌘'; }
  else                    { name = 'New Moon';        icon = '🌑'; }
  const daysToFull = phase < 14.77 ? (14.77 - phase) : (LUNAR_CYCLE - phase + 14.77);
  return { name, icon, phase, fraction, daysToFull: Math.round(daysToFull) };
}

// ─── 1. Wave Observations (Open-Meteo Marine current) ────────────────────────
async function loadBuoy() {
  try {
    const currentVars = 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period';
    const hourlyVars  = 'sea_surface_temperature';
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT()}&longitude=${LNG()}`
      + `&current=${currentVars}&hourly=${hourlyVars}`
      + `&length_unit=imperial&timezone=auto&forecast_days=1`;
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

    const now = new Date();
    const hours = d.hourly.time;
    let sstC = null;
    for (let i = 0; i < hours.length; i++) {
      if (new Date(hours[i]) <= now) sstC = d.hourly.sea_surface_temperature[i];
    }
    const sstF = sstC !== null && sstC !== undefined ? (sstC * 9/5 + 32).toFixed(0) : '—';

    const srcLink = ACTIVE.buoyId
      ? `<a href="https://www.ndbc.noaa.gov/station_page.php?station=${ACTIVE.buoyId}" target="_blank" rel="noopener" class="src-link">NDBC Buoy ${ACTIVE.buoyId} ↗</a>`
      : `<a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noopener" class="src-link">Open-Meteo Marine API ↗</a>`;

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
      <div class="buoy-source">${srcLink}</div>
    `);
  } catch (e) {
    setHTML('buoy-body', errorHTML('Wave data unavailable: ' + e.message));
  }
}

// ─── 2. Open-Meteo Marine (Swell Forecast) ────────────────────────────────────
async function loadSwell() {
  try {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT()}&longitude=${LNG()}`
      + `&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction`
      + `&wind_speed_unit=kn&length_unit=imperial&timezone=auto&forecast_days=2&models=best_match`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const now = new Date();
    const hours = d.hourly.time;
    let idx = 0;
    for (let i = 0; i < hours.length; i++) {
      if (new Date(hours[i]) <= now) idx = i;
    }

    const wvHt  = d.hourly.wave_height[idx];
    const wvPer = d.hourly.wave_period[idx];
    const wvDir = d.hourly.wave_direction[idx];
    const swHt  = d.hourly.swell_wave_height[idx];
    const swPer = d.hourly.swell_wave_period[idx];
    const swDir = d.hourly.swell_wave_direction[idx];

    const dirStr   = degToCompass(wvDir);
    const swDirStr = degToCompass(swDir);

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

    const srcLink = ACTIVE.buoyId
      ? `<a href="https://www.ndbc.noaa.gov/station_page.php?station=${ACTIVE.buoyId}" target="_blank" rel="noopener" class="src-link">NDBC Buoy ${ACTIVE.buoyId} ↗</a>`
      : `<a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noopener" class="src-link">Open-Meteo Marine API ↗</a>`;

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
      <div class="buoy-source" style="margin-top:6px">${srcLink}</div>
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
      + `&wind_speed_unit=kn&timezone=auto&forecast_days=2`;
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
    renderWindForecast(d.hourly, idx);
  } catch (e) {
    setHTML('wind-body', errorHTML('Wind data unavailable: ' + e.message));
    setHTML('wind-forecast-body', errorHTML('Wind forecast unavailable'));
  }
}

function renderWindForecast(hourly, currentIdx) {
  const times  = hourly.time;
  const speeds = hourly.wind_speed_10m;
  const gusts  = hourly.wind_gusts_10m;
  const dirs   = hourly.wind_direction_10m;

  // Collect next 48 hours of data points starting from current hour
  const pts = [];
  for (let i = currentIdx; i < times.length && pts.length < 48; i++) {
    pts.push({ t: new Date(times[i]), spd: speeds[i] ?? 0, gst: gusts[i] ?? 0, dir: dirs[i] ?? 0 });
  }
  if (pts.length < 2) { setHTML('wind-forecast-body', errorHTML('Not enough forecast data')); return; }

  // ── SVG chart (speed + gusts) ────────────────────────────────────────────
  const W = 320, H = 100, PL = 32, PR = 6, PT = 8, PB = 18;
  const cW = W - PL - PR, cH = H - PT - PB;

  const allVals = [...pts.map(p => p.spd), ...pts.map(p => p.gst)];
  const maxV = Math.max(...allVals, 5);
  const tStart = pts[0].t.getTime();
  const tEnd   = pts[pts.length - 1].t.getTime();
  const tRange = tEnd - tStart;

  const tx = t => PL + ((t.getTime() - tStart) / tRange) * cW;
  const ty = v => PT + (1 - v / maxV) * cH;

  // Filled area under speed line
  const speedPts = pts.map(p => `${tx(p.t).toFixed(1)},${ty(p.spd).toFixed(1)}`).join(' ');
  const areaPath = `M${tx(pts[0].t).toFixed(1)},${ty(0).toFixed(1)} `
    + pts.map(p => `L${tx(p.t).toFixed(1)},${ty(p.spd).toFixed(1)}`).join(' ')
    + ` L${tx(pts[pts.length-1].t).toFixed(1)},${ty(0).toFixed(1)} Z`;

  const gustPts = pts.map(p => `${tx(p.t).toFixed(1)},${ty(p.gst).toFixed(1)}`).join(' ');

  // Y-axis labels
  const yStep = maxV <= 10 ? 5 : maxV <= 20 ? 10 : 15;
  let yLabels = '';
  for (let v = 0; v <= maxV; v += yStep) {
    yLabels += `<text x="${PL - 3}" y="${ty(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#607d8b" font-size="8" font-family="monospace">${v}</text>`;
    yLabels += `<line x1="${PL}" y1="${ty(v).toFixed(1)}" x2="${W - PR}" y2="${ty(v).toFixed(1)}" stroke="#1a2e45" stroke-width="0.5"/>`;
  }

  // X-axis: one tick every 6 hours
  let xLabels = '';
  const now = new Date();
  for (const p of pts) {
    if (p.t.getHours() % 6 === 0) {
      const x = tx(p.t).toFixed(1);
      const label = p.t.getHours() === 0
        ? p.t.toLocaleDateString([], { weekday: 'short' })
        : p.t.getHours() + 'h';
      xLabels += `<line x1="${x}" y1="${PT}" x2="${x}" y2="${PT + cH}" stroke="#1a2e45" stroke-width="0.5"/>`;
      xLabels += `<text x="${x}" y="${H - 3}" text-anchor="middle" fill="#607d8b" font-size="8" font-family="monospace">${label}</text>`;
    }
  }

  // "Now" marker
  const nowX = Math.max(PL, Math.min(W - PR, tx(now))).toFixed(1);
  const nowLine = `<line x1="${nowX}" y1="${PT}" x2="${nowX}" y2="${PT + cH}" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-dasharray="3,3"/>
    <text x="${nowX}" y="${PT - 1}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="7" font-family="monospace">NOW</text>`;

  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;margin-bottom:10px">
    ${yLabels}${xLabels}${nowLine}
    <path d="${areaPath}" fill="rgba(0,200,83,0.15)"/>
    <polyline points="${speedPts}" fill="none" stroke="#00c853" stroke-width="1.5" stroke-linejoin="round"/>
    <polyline points="${gustPts}"  fill="none" stroke="#ffeb3b" stroke-width="1"   stroke-linejoin="round" stroke-dasharray="3,2"/>
  </svg>`;

  // Legend
  const legend = `<div style="display:flex;gap:14px;margin-bottom:8px;font-size:10px;color:var(--text-muted);font-family:monospace">
    <span><span style="display:inline-block;width:16px;height:2px;background:#00c853;vertical-align:middle;margin-right:4px"></span>Speed</span>
    <span><span style="display:inline-block;width:16px;height:1px;background:#ffeb3b;vertical-align:middle;margin-right:4px;border-top:1px dashed #ffeb3b"></span>Gusts</span>
  </div>`;

  // Direction table — every 3 hours, next 24 hours
  const dirSamples = [];
  for (let i = 0; i < pts.length && dirSamples.length < 8; i++) {
    if (i === 0 || pts[i].t.getHours() % 3 === 0) dirSamples.push(pts[i]);
  }

  const dirRows = dirSamples.map(p => {
    const spdColor = p.spd < 10 ? '#00c853' : p.spd < 20 ? '#1e90ff' : p.spd < 30 ? '#ffeb3b' : '#f44336';
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1">
      <span style="font-size:9px;color:var(--text-muted);font-family:monospace">${fmtTime(p.t).replace(':00','')}</span>
      <span style="display:inline-block;transform:rotate(${p.dir + 180}deg);font-size:14px;line-height:1;color:#00c853">↑</span>
      <span style="font-size:9px;font-family:monospace;color:var(--text-muted)">${degToCompass(p.dir)}</span>
      <span style="font-size:10px;font-weight:bold;font-family:monospace;color:${spdColor}">${p.spd.toFixed(0)}</span>
    </div>`;
  }).join('');

  const dirTable = `<div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-family:monospace">Direction Outlook · kts</div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:8px">${dirRows}</div>`;

  setHTML('wind-forecast-body', legend + svg + dirTable
    + `<div class="buoy-source"><a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener" class="src-link">Open-Meteo Weather API ↗</a></div>`);
}

function renderWind(speedKts, gustKts, dir) {
  const [cls, desc] = windClass(speedKts);
  const dirStr = degToCompass(dir);

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

  const srcLink = ACTIVE?.isUS
    ? `<a href="https://forecast.weather.gov/MapClick.php?lat=${LAT()}&lon=${LNG()}" target="_blank" rel="noopener" class="src-link">NWS Point Forecast ↗</a>`
    : `<a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener" class="src-link">Open-Meteo Weather ↗</a>`;

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
    <div class="buoy-source" style="margin-top:6px">${srcLink}</div>
  `);
}

// ─── 4. NOAA Tides ────────────────────────────────────────────────────────────
async function loadTides() {
  if (!ACTIVE?.tideStation) return;

  try {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
      + `?begin_date=${fmtDate(today)}&end_date=${fmtDate(tomorrow)}&station=${NOAA_STATION()}`
      + `&datum=MLLW&time_zone=lst_ldt&units=english&application=web_services&format=json`;

    const [hourlyRes, hiloRes] = await Promise.all([
      fetch(base + '&product=predictions&interval=h'),
      fetch(base + '&product=predictions&interval=hilo'),
    ]);
    if (!hourlyRes.ok || !hiloRes.ok) throw new Error('HTTP error');
    const [hourlyData, hiloData] = await Promise.all([hourlyRes.json(), hiloRes.json()]);
    if (hourlyData.error) throw new Error(hourlyData.error.message);
    if (hiloData.error) throw new Error(hiloData.error.message);

    // NOAA returns "YYYY-MM-DD HH:MM" — replace space with T for mobile compat
    const parseNoaaDate = s => new Date(s.replace(' ', 'T'));

    const hourly = hourlyData.predictions.map(p => ({ t: parseNoaaDate(p.t), v: parseFloat(p.v) }));
    const events = hiloData.predictions.map(p => ({ t: parseNoaaDate(p.t), v: parseFloat(p.v), type: p.type }));
    const now = new Date();

    // ── SVG tide chart ──────────────────────────────────────────────────────
    const W = 320, H = 110, PL = 30, PR = 8, PT = 12, PB = 20;
    const chartW = W - PL - PR, chartH = H - PT - PB;

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

    const pts = visible.map(p => [tx(p.t), ty(p.v)]);
    let pathD = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const cpx = (pts[i-1][0] + pts[i][0]) / 2;
      pathD += ` C ${cpx.toFixed(1)},${pts[i-1][1].toFixed(1)} ${cpx.toFixed(1)},${pts[i][1].toFixed(1)} ${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
    }

    const fillD = pathD
      + ` L ${pts[pts.length-1][0].toFixed(1)},${(PT + chartH).toFixed(1)}`
      + ` L ${pts[0][0].toFixed(1)},${(PT + chartH).toFixed(1)} Z`;

    const nowX = tx(now).toFixed(1);
    const nowV = (() => {
      for (let i = 1; i < visible.length; i++) {
        if (visible[i].t >= now) {
          const frac = (now - visible[i-1].t) / (visible[i].t - visible[i-1].t);
          return visible[i-1].v + frac * (visible[i].v - visible[i-1].v);
        }
      }
      return visible[visible.length-1].v;
    })();
    const nowY = ty(nowV).toFixed(1);

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

    let xLabels = '';
    for (let h = 0; h <= 24; h += 6) {
      const t = new Date(tStart.getTime() + h * 3600000);
      const x = tx(t).toFixed(1);
      const lbl = t.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' ', '');
      xLabels += `<text x="${x}" y="${(H - 4).toFixed(1)}" text-anchor="middle" font-size="8" fill="#4a7a96">${lbl}</text>`;
    }

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
        <path d="${fillD}" fill="url(#tideFill)"/>
        <path d="${pathD}" fill="none" stroke="#1e90ff" stroke-width="2" stroke-linejoin="round"/>
        <line x1="${nowX}" y1="${PT}" x2="${nowX}" y2="${PT + chartH}" stroke="#00d4aa" stroke-width="1.5" stroke-dasharray="3,3"/>
        <circle cx="${nowX}" cy="${nowY}" r="4" fill="#00d4aa" stroke="#0f1f3d" stroke-width="1.5"/>
        <text x="${nowX}" y="${(parseFloat(nowY) - 8).toFixed(1)}" text-anchor="middle" font-size="8" fill="#00d4aa" font-weight="700">${nowV.toFixed(1)}ft</text>
        ${eventMarkers}
        ${xLabels}
        ${yLabels}
      </svg>`;

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
      <div class="buoy-source" style="margin-top:6px"><a href="https://tidesandcurrents.noaa.gov/waterlevels.html?id=${NOAA_STATION()}" target="_blank" rel="noopener" class="src-link">NOAA Tides & Currents · Station ${NOAA_STATION()} ↗</a></div>
    `);
  } catch (e) {
    setHTML('tides-body', errorHTML('Tide data unavailable: ' + e.message));
  }
}

// ─── 5. NWS Marine Forecast ───────────────────────────────────────────────────
async function loadMarineForecast() {
  const zone   = ACTIVE.marineZone;
  const office = ACTIVE.cwfOffice;

  if (!zone || !office) {
    setHTML('marine-body', errorHTML('Marine forecast not available for this location'));
    return;
  }

  try {
    const listRes = await fetch(`https://api.weather.gov/products/types/CWF/locations/${office}`, {
      headers: { 'User-Agent': 'DBsLocal/1.0', 'Accept': 'application/geo+json' }
    });
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
    const listData = await listRes.json();
    const firstID = listData['@graph']?.[0]?.id;
    if (!firstID) throw new Error('No CWF products found');

    const prodRes = await fetch(`https://api.weather.gov/products/${firstID}`, {
      headers: { 'User-Agent': 'DBsLocal/1.0' }
    });
    if (!prodRes.ok) throw new Error(`HTTP ${prodRes.status}`);
    const prodData = await prodRes.json();
    const fullText = prodData.productText;
    if (!fullText) throw new Error('No product text');

    const zoneIdx = fullText.indexOf(zone + '-');
    if (zoneIdx === -1) throw new Error(`${zone} zone not found in CWF`);

    const afterZone = fullText.slice(zoneIdx);
    const sectionLines = afterZone.split('\n');
    const body = [];
    for (const line of sectionLines) {
      if (line.startsWith('$$')) break;
      body.push(line);
    }
    const forecastText = body.slice(3).join('\n').trim();
    if (!forecastText) throw new Error('Empty forecast section');

    const blocks = forecastText.split(/\n(?=\.)/).filter(b => b.trim());
    const html = blocks.slice(0, 4).map(block => {
      const raw = block.trim().replace(/^\./, '');
      const dotdot = raw.indexOf('...');
      let title, detail;
      if (dotdot !== -1) {
        title  = raw.slice(0, dotdot).trim();
        detail = raw.slice(dotdot + 3).replace(/\n/g, ' ').trim();
      } else {
        title  = raw.split('\n')[0].trim();
        detail = raw.split('\n').slice(1).join(' ').trim();
      }
      return `
        <div style="margin-bottom:10px">
          <div style="font-size:11px;font-weight:600;color:var(--accent-blue);margin-bottom:3px">${title}</div>
          <div class="forecast-text">${detail}</div>
        </div>`;
    }).join('');

    setHTML('marine-body', (html || errorHTML('No forecast periods available'))
      + `<div class="buoy-source" style="margin-top:8px"><a href="https://www.weather.gov/${office.toLowerCase()}/CWF" target="_blank" rel="noopener" class="src-link">NWS Coastal Waters Forecast · ${zone} ↗</a></div>`);
  } catch (e) {
    setHTML('marine-body', errorHTML('Marine forecast unavailable: ' + e.message));
  }
}

// ─── 6. NWS Rip Current ───────────────────────────────────────────────────────
async function loadRipCurrent() {
  try {
    let forecastUrl = ACTIVE.forecastUrl || null;

    if (!forecastUrl) {
      try {
        const ptRes = await fetch(`https://api.weather.gov/points/${LAT()},${LNG()}`);
        if (ptRes.ok) {
          const ptData = await ptRes.json();
          forecastUrl = ptData.properties?.forecast || null;
        }
      } catch(e) {}
    }

    if (!forecastUrl) {
      // Last-resort fallback: MTR Monterey grid
      forecastUrl = `https://api.weather.gov/gridpoints/MTR/92,81/forecast`;
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

    if (!ripText) ripText = 'No rip current advisories in effect.';

    const levelLabel = ripLevel.charAt(0).toUpperCase() + ripLevel.slice(1);
    setBadge('rip-badge', levelLabel.toUpperCase(),
      ripLevel === 'low' ? '#00c853' : ripLevel === 'moderate' ? '#ffeb3b' : '#f44336',
      ripLevel === 'low' ? 'rgba(0,200,83,0.15)' : ripLevel === 'moderate' ? 'rgba(255,235,59,0.15)' : 'rgba(244,67,54,0.15)');

    setHTML('rip-body', `
      <div class="rip-indicator">
        <div class="rip-level ${ripLevel}">${levelLabel}</div>
        <div class="rip-desc">${ripText.substring(0, 200)}${ripText.length > 200 ? '…' : ''}</div>
      </div>
      <div class="buoy-source" style="margin-top:8px"><a href="https://www.weather.gov/mtr/rip" target="_blank" rel="noopener" class="src-link">NWS Rip Current Outlook ↗</a></div>
    `);
  } catch (e) {
    setHTML('rip-body', errorHTML('Rip current data unavailable: ' + e.message));
  }
}

// ─── NWS dispatcher ───────────────────────────────────────────────────────────
async function loadNWS() {
  if (!ACTIVE?.isUS) return;
  const tasks = [];
  if (ACTIVE.marineZone && ACTIVE.cwfOffice) tasks.push(loadMarineForecast());
  tasks.push(loadRipCurrent());
  await Promise.allSettled(tasks);
}

// ─── Refresh all ──────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!ACTIVE) return;

  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  setHTML('lastUpdated', 'Updating…');

  // Reset visible card bodies to loading state
  setHTML('buoy-body',          loadingHTML());
  setHTML('swell-body',         loadingHTML());
  setHTML('wind-body',          loadingHTML());
  setHTML('wind-forecast-body', loadingHTML());
  if (ACTIVE.isUS && ACTIVE.tideStation) setHTML('tides-body',  loadingHTML());
  if (ACTIVE.isUS && ACTIVE.marineZone)  setHTML('marine-body', loadingHTML());
  if (ACTIVE.isUS)                       setHTML('rip-body',    loadingHTML());

  await Promise.allSettled([
    loadBuoy(),
    loadSwell(),
    loadWeather(),
    ACTIVE.isUS && ACTIVE.tideStation ? loadTides() : Promise.resolve(),
    ACTIVE.isUS ? loadNWS() : Promise.resolve(),
  ]);

  btn.classList.remove('spinning');
  setHTML('lastUpdated', `Updated ${fmtTime(new Date())}`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSpots();

if (SAVED_SPOTS.length === 0) {
  // First-time user — show onboarding
  openSpotEditor(false);
} else {
  const savedActiveId = localStorage.getItem('surf_active_spot');
  ACTIVE = SAVED_SPOTS.find(s => s.id === savedActiveId) || SAVED_SPOTS[0];
  renderLocationPills();
  updateSubtitle();
  updateCardVisibility();
  refreshAll();
}

// Auto-refresh every 10 minutes
setInterval(refreshAll, 10 * 60 * 1000);
