// ─── Config ───────────────────────────────────────────────────────────────────
const WORKER_URL = 'https://surf-alerts.dbales1210.workers.dev';
const VAPID_PUBLIC_KEY = 'BFBSS-y5LgAuMfFCW2Vht2wYdxJBSNvQ-O9pHy98Ink35jeBCfxsaj0CF0xXcr8eXG3OFHYgFUP3IX-bsFh_1Oc';

// ─── Service Worker + Push Notifications ──────────────────────────────────────
let _swReg = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
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

const MAX_SPOTS = 5;

let SAVED_SPOTS = [];
let ACTIVE = null;
let pendingSpots = []; // working copy while editor is open

const DEFAULT_SPOTS = [
  { id: 'carmel',   name: 'Carmel Beach',  lat: 36.5535, lng: -121.9255, beachFacing: 280, isUS: true, buoyId: '46042', tideStation: '9413450', marineZone: 'PZZ535', cwfOffice: 'MTR', forecastUrl: 'https://api.weather.gov/gridpoints/MTR/91,48/forecast' },
  { id: 'asilomar', name: 'Asilomar',       lat: 36.6213, lng: -121.9427, beachFacing: 285, isUS: true, buoyId: '46042', tideStation: '9413450', marineZone: 'PZZ535', cwfOffice: 'MTR', forecastUrl: 'https://api.weather.gov/gridpoints/MTR/91,51/forecast' },
  { id: 'bigsur',   name: 'Big Sur',        lat: 36.2344, lng: -121.8173, beachFacing: 270, isUS: true, buoyId: '46042', tideStation: '9413450', marineZone: 'PZZ565', cwfOffice: 'MTR', forecastUrl: 'https://api.weather.gov/gridpoints/MTR/92,33/forecast' },
  { id: 'steamer',  name: 'Steamer Lane',   lat: 36.9516, lng: -122.0255, beachFacing: 210, isUS: true, buoyId: '46042', tideStation: '9413450', marineZone: 'PZZ535', cwfOffice: 'MTR', forecastUrl: 'https://api.weather.gov/gridpoints/MTR/91,66/forecast' },
  { id: 'mosslanding', name: 'Moss Landing', lat: 36.8035, lng: -121.7909, beachFacing: 265, isUS: true, buoyId: '46042', tideStation: '9413450', marineZone: 'PZZ535', cwfOffice: 'MTR', forecastUrl: 'https://api.weather.gov/gridpoints/MTR/98,58/forecast' },
];

// Beach facing for the active spot. Saved spots from before this feature (and
// custom spots) may lack beachFacing — backfill defaults by id, else null.
function BEACH_FACING() {
  if (typeof ACTIVE?.beachFacing === 'number') return ACTIVE.beachFacing;
  const def = DEFAULT_SPOTS.find(s => s.id === ACTIVE?.id);
  return typeof def?.beachFacing === 'number' ? def.beachFacing : null;
}

function loadSpots() {
  try {
    const raw = localStorage.getItem('surf_spots_v2');
    SAVED_SPOTS = raw ? JSON.parse(raw) : DEFAULT_SPOTS;
  } catch(e) { SAVED_SPOTS = DEFAULT_SPOTS; }
  // One-time backfill: add Moss Landing to existing installs that predate it.
  if (SAVED_SPOTS.length < MAX_SPOTS && !SAVED_SPOTS.find(s => s.id === 'mosslanding')) {
    SAVED_SPOTS.push(DEFAULT_SPOTS.find(s => s.id === 'mosslanding'));
    saveSpots();
  }
}

function saveSpots() {
  localStorage.setItem('surf_spots_v2', JSON.stringify(SAVED_SPOTS));
}

function genId() {
  return crypto.randomUUID();
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
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ─── Onboarding / Spot Editor ─────────────────────────────────────────────────
let _searchResults = [];
let _searchTimer = null;
let _isEditMode = false;

function openSpotEditor(editMode) {
  _isEditMode = !!editMode;
  pendingSpots = [...SAVED_SPOTS];

  document.getElementById('onboarding-title').textContent = editMode ? 'Edit Spots' : "Waves";
  document.getElementById('onboarding-sub').textContent  = editMode
    ? 'Manage your local surf spots'
    : `Add up to ${MAX_SPOTS} of your local surf spots`;
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
      if (pendingSpots.length >= MAX_SPOTS) {
        status.textContent = `Maximum ${MAX_SPOTS} spots reached`;
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
  if (!result || pendingSpots.length >= MAX_SPOTS) return;

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
  const remaining = MAX_SPOTS - pendingSpots.length;
  const hint = remaining > 0
    ? `${remaining} more spot${remaining !== 1 ? 's' : ''} can be added`
    : `Maximum ${MAX_SPOTS} spots reached`;

  list.innerHTML = pendingSpots.map((s, i) => {
    const isDefault = DEFAULT_SPOTS.find(d => d.id === s.id);
    return `
    <div class="added-spot-item" data-idx="${i}">
      <span class="drag-handle" data-idx="${i}">☰</span>
      <span class="added-spot-flag">${s.isUS ? '🇺🇸' : '🌍'}</span>
      <div class="added-spot-info">
        <span class="added-spot-name">${escapeHtml(s.name)}</span>
        <span class="added-spot-meta">${s.isUS
          ? (s.tideStation ? '✓ Tides' : '— No tides') + (s.marineZone ? ' · ✓ Forecast' : '')
          : 'Waves &amp; wind only'}${s.beachFacing != null ? ' · 🧭 ' + degToCompass(s.beachFacing) : ''}</span>
      </div>
      <button class="remove-spot-btn" onclick="removePendingSpot(${i})">×</button>
    </div>
    ${!isDefault ? facingPickerHTML(i) : ''}`;
  }).join('') + `<div class="spots-hint">${hint}</div>`;

  initSpotDrag(list);
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

  const tidesCard  = document.getElementById('card-tides');
  const marineCard = document.getElementById('card-marine');

  if (tidesCard)  tidesCard.style.display  = hasTides  ? '' : 'none';
  if (marineCard) marineCard.style.display = hasMarine ? '' : 'none';

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
function fmtHourShort(t) {
  const h = t.getHours();
  if (h === 0) return '12a';
  if (h < 12) return h + 'a';
  if (h === 12) return '12p';
  return (h - 12) + 'p';
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function toggleSection(headerEl) {
  const section = headerEl.closest('.section');
  if (section) section.classList.toggle('collapsed');
}

function setBadge(id, label, color, bg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = label; el.style.color = color; el.style.background = bg; }
}

function loadingHTML() {
  return '<div class="loading"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div>';
}

function errorHTML(msg) {
  return `<div class="error-msg">⚠ ${escapeHtml(msg)}</div>`;
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

// ─── Wetsuit recommendation based on water temp (°F) ─────────────────────────
function wetsuitRec(tempF) {
  if (tempF >= 72) return { icon: '🩳', label: 'Boardshorts / Bikini — no wetsuit needed' };
  if (tempF >= 68) return { icon: '🤿', label: 'Spring suit (2mm)' };
  if (tempF >= 63) return { icon: '🧥', label: 'Full suit (3/2mm)' };
  if (tempF >= 58) return { icon: '🧥', label: 'Full suit (4/3mm)' };
  if (tempF >= 52) return { icon: '🥾', label: 'Full suit + boots (5/4mm)' };
  return { icon: '🧊', label: 'Full suit + hood + boots (6/5mm)' };
}

// ─── 1. Wave Observations (NDBC buoy → Open-Meteo fallback) ─────────────────
// Stores latest NDBC observations for accuracy tracking
let _ndbcWind = null;
let _ndbcWave = null;

async function fetchNDBC(buoyId) {
  const res = await fetch(`${WORKER_URL}/proxy/ndbc/${buoyId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || 'NDBC unavailable');
  return d;
}

async function loadBuoy() {
  try {
    let wvhtFt, dpd, mwd, dirStr, swHt, swPer, swDir, sstF, sstC, srcLink, isObserved;
    _ndbcWind = null;
    _ndbcWave = null;

    // Try NDBC buoy first for real observations
    if (ACTIVE.buoyId) {
      try {
        const ndbc = await fetchNDBC(ACTIVE.buoyId);
        const wv = ndbc.wave;
        const sw = ndbc.swell;
        // Only use NDBC if it has actual wave data (not all MM/null)
        if (wv.height_m !== null) {
          wvhtFt = (wv.height_m * 3.28084).toFixed(1);
          dpd    = wv.period_s !== null ? Math.round(wv.period_s) + '' : '—';
          mwd    = wv.direction;

          // Store for accuracy tracking
          _ndbcWave = {
            heightFt: wv.height_m * 3.28084,
            period: wv.period_s,
          };
          dirStr = mwd !== null ? degToCompass(mwd) : '—';
          swHt   = sw && sw.height_m !== null ? (sw.height_m * 3.28084).toFixed(1) : '—';
          swPer  = sw && sw.period_s !== null ? Math.round(sw.period_s) + '' : '—';
          swDir  = sw ? sw.direction : null;
          sstC   = ndbc.waterTemp_c;
          sstF   = sstC !== null && sstC !== undefined ? (sstC * 9/5 + 32).toFixed(0) : '—';
          isObserved = true;
          srcLink = `<a href="https://www.ndbc.noaa.gov/station_page.php?station=${ACTIVE.buoyId}" target="_blank" rel="noopener" class="src-link">NDBC Buoy ${ACTIVE.buoyId} · Observed ↗</a>`;
        } else {
          console.warn('NDBC buoy wave data unavailable (MM), falling back to model');
        }

        // Store wind for the wind card
        if (ndbc.wind && ndbc.wind.speed_ms !== null) {
          _ndbcWind = {
            speedKts: ndbc.wind.speed_ms * 1.94384,
            gustKts:  ndbc.wind.gust_ms !== null ? ndbc.wind.gust_ms * 1.94384 : null,
            dir:      ndbc.wind.direction,
          };
        }
      } catch (e) {
        console.warn('NDBC fetch failed, falling back to Open-Meteo:', e.message);
      }
    }

    // Fall back to Open-Meteo model if NDBC unavailable
    if (!isObserved) {
      const currentVars = 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period';
      const hourlyVars  = 'sea_surface_temperature';
      const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT()}&longitude=${LNG()}`
        + `&current=${currentVars}&hourly=${hourlyVars}`
        + `&length_unit=imperial&timezone=auto&forecast_days=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const c = d.current;
      wvhtFt = c.wave_height?.toFixed(1) ?? '—';
      dpd    = c.wave_period?.toFixed(0) ?? '—';
      mwd    = c.wave_direction ?? null;
      dirStr = mwd !== null ? degToCompass(mwd) : '—';
      swHt   = c.swell_wave_height?.toFixed(1) ?? '—';
      swPer  = c.swell_wave_period?.toFixed(0) ?? '—';
      swDir  = c.swell_wave_direction ?? null;
      const now = new Date();
      const hours = d.hourly.time;
      sstC = null;
      for (let i = 0; i < hours.length; i++) {
        if (new Date(hours[i]) <= now) sstC = d.hourly.sea_surface_temperature[i];
      }
      sstF = sstC !== null && sstC !== undefined ? (sstC * 9/5 + 32).toFixed(0) : '—';
      isObserved = false;
      srcLink = `<a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noopener" class="src-link">Open-Meteo Marine API ↗</a>`;
    }

    const sourceTag = isObserved ? 'Observed (NDBC buoy)' : 'Model estimate';
    setBadge('buoy-badge', isObserved ? 'BUOY' : 'MODEL',
      isObserved ? '#00d4aa' : '#7eb8d4',
      isObserved ? 'rgba(0,212,170,0.15)' : 'rgba(126,184,212,0.15)');

    // Period classification
    const dpdNum = parseFloat(dpd);
    const perTag = isNaN(dpdNum) ? null
      : dpdNum >= 16 ? { label: 'Long-Period Groundswell', color: '#9b6dff', icon: '🟣' }
      : dpdNum >= 12 ? { label: 'Groundswell', color: '#1e90ff', icon: '🔵' }
      : dpdNum >= 8  ? { label: 'Mid-Period Swell', color: '#00d4aa', icon: '🟢' }
      :                { label: 'Wind Swell', color: '#ffb300', icon: '🟡' };

    const perColor = perTag ? perTag.color : 'var(--text-primary)';
    const perBadge = perTag && dpdNum >= 12
      ? `<div style="margin-top:6px;padding:5px 8px;border-radius:6px;background:${perTag.color}15;border:1px solid ${perTag.color}40;font-size:11px;font-family:monospace;color:${perTag.color}">
          ${perTag.icon} ${perTag.label} - ${dpd}s period${dpdNum >= 16 ? ' - rare event' : ''}
        </div>`
      : '';

    const perLabel = perTag ? `<div style="font-size:9px;color:${perColor};font-family:monospace;margin-top:2px">${perTag.label}</div>` : '';

    setHTML('buoy-body', `
      <div id="buoy-quality" style="margin-bottom:6px"></div>
      <div class="stat-row">
        <span class="stat-value" style="color:#00d4aa">${wvhtFt}</span>
        ${wvhtFt !== '—' ? '<span class="stat-unit">ft</span>' : ''}
      </div>
      <div class="stat-label">${sourceTag}</div>
      <div style="margin-top:6px;font-size:11px;font-family:monospace;color:var(--text-secondary)">
        <div><span style="color:${perColor};font-weight:600">${dpd}s</span> period${perLabel}</div>
        <div style="margin-top:3px">${dirStr} <span style="color:var(--text-muted)">${mwd !== null ? mwd + '°' : ''}</span></div>
      </div>
    `);
    renderQuality();

    // ── Water Temperature card ─────────────────────────────────────────────
    const gearRec = sstF !== '—' ? wetsuitRec(parseFloat(sstF)) : null;
    const celsiusSub = sstC !== null && sstC !== undefined ? ` · ${sstC.toFixed(1)}°C` : '';
    setHTML('water-temp-body', sstF !== '—' ? `
      <div class="stat-row">
        <span class="stat-value" style="color:#1e90ff">${sstF}</span>
        <span class="stat-unit">°F</span>
      </div>
      <div class="stat-label">${gearRec ? gearRec.label : ''}${celsiusSub}</div>
      <div class="buoy-source">${srcLink}</div>
    ` : errorHTML('Water temperature unavailable'));
    const tempBadge = document.getElementById('water-temp-badge');
    if (tempBadge) tempBadge.textContent = sstF !== '—' ? `${sstF}°F` : '--';
  } catch (e) {
    setHTML('buoy-body', errorHTML('Wave data unavailable: ' + e.message));
    setHTML('water-temp-body', errorHTML('Water temperature unavailable'));
  }
}

// ─── Swell chart canvas helpers ───────────────────────────────────────────────
function drawSwellChart(canvas, pts, hlIdx) {
  const DPR = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth || 320;
  const H   = 80;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  const PL = 32, PR = 6, PT = 8, PB = 14;
  const cW = W - PL - PR, cH = H - PT - PB;

  const maxV  = Math.max(...pts.map(p => p.wvHt), 1);
  const tStart = pts[0].t.getTime();
  const tEnd   = pts[pts.length - 1].t.getTime();
  const tRange = tEnd - tStart;
  const tx = t => PL + ((t.getTime() - tStart) / tRange) * cW;
  const ty = v => PT + (1 - v / maxV) * cH;

  ctx.clearRect(0, 0, W, H);

  // Grid + Y labels
  const yStep = maxV <= 4 ? 1 : maxV <= 8 ? 2 : 3;
  ctx.font = '8px monospace';
  for (let v = 0; v <= maxV; v += yStep) {
    const y = ty(v);
    ctx.strokeStyle = '#1a2e45'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
    ctx.fillStyle = '#607d8b';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(v), PL - 3, y);
  }

  // X labels
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const p of pts) {
    if (p.t.getHours() % 6 === 0) {
      const x = tx(p.t);
      const label = p.t.getHours() === 0
        ? p.t.toLocaleDateString([], { weekday: 'short' })
        : p.t.getHours() + 'h';
      ctx.strokeStyle = '#1a2e45'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + cH); ctx.stroke();
      ctx.fillStyle = '#607d8b';
      ctx.fillText(label, x, H - 3);
    }
  }

  // Wave height filled area
  ctx.beginPath();
  ctx.moveTo(tx(pts[0].t), ty(0));
  for (const p of pts) ctx.lineTo(tx(p.t), ty(p.wvHt));
  ctx.lineTo(tx(pts[pts.length - 1].t), ty(0));
  ctx.closePath();
  ctx.fillStyle = 'rgba(30,144,255,0.15)';
  ctx.fill();

  // Wave height line
  ctx.beginPath();
  ctx.moveTo(tx(pts[0].t), ty(pts[0].wvHt));
  for (const p of pts) ctx.lineTo(tx(p.t), ty(p.wvHt));
  ctx.strokeStyle = '#1e90ff'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
  ctx.setLineDash([]); ctx.stroke();

  // Swell height line (dashed)
  ctx.beginPath();
  ctx.moveTo(tx(pts[0].t), ty(pts[0].swHt));
  for (const p of pts) ctx.lineTo(tx(p.t), ty(p.swHt));
  ctx.strokeStyle = '#00d4aa'; ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 2]); ctx.stroke();
  ctx.setLineDash([]);

  // NOW marker
  const nowX = Math.max(PL, Math.min(W - PR, tx(pts[0].t)));
  ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(nowX, PT); ctx.lineTo(nowX, PT + cH); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('NOW', nowX, PT - 1);

  // Highlight crosshair
  if (hlIdx !== null && hlIdx >= 0 && hlIdx < pts.length) {
    const p  = pts[hlIdx];
    const hx = tx(p.t);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, PT); ctx.lineTo(hx, PT + cH); ctx.stroke();

    // Dot on wave line
    ctx.beginPath(); ctx.arc(hx, ty(p.wvHt), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#1e90ff'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();

    // Dot on swell line
    ctx.beginPath(); ctx.arc(hx, ty(p.swHt), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#00d4aa'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
  }
}

function setupSwellChart(pts) {
  const canvas = document.getElementById('swell-chart-canvas');
  const tip    = document.getElementById('swell-chart-tip');
  if (!canvas || !tip) return;

  const PL = 32, PR = 6;
  const tStart = pts[0].t.getTime();
  const tEnd   = pts[pts.length - 1].t.getTime();
  const tRange = tEnd - tStart;

  function idxFromClientX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const cW   = rect.width - PL - PR;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left - PL) / cW));
    const tgt  = tStart + frac * tRange;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].t.getTime() - tgt);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function showTip(clientX) {
    const i = idxFromClientX(clientX);
    const p = pts[i];
    drawSwellChart(canvas, pts, i);

    const rect  = canvas.getBoundingClientRect();
    const cW    = rect.width - PL - PR;
    const dotX  = PL + ((p.t.getTime() - tStart) / tRange) * cW;
    const tipW  = tip.offsetWidth || 140;
    tip.style.left = (dotX > cW / 2 ? Math.max(0, dotX - tipW - 8) : dotX + 10) + 'px';

    tip.innerHTML = `
      <div style="font-size:10px;color:#00d4aa;font-family:monospace;margin-bottom:3px">
        ${fmtTime(p.t)} ${p.t.toLocaleDateString([], { weekday: 'short' })}
      </div>
      <div style="font-size:12px;color:#1e90ff;font-family:monospace">
        Wave <b>${p.wvHt.toFixed(1)} ft</b> · ${p.per.toFixed(0)}s
      </div>
      <div style="font-size:11px;color:#00d4aa;font-family:monospace">
        Swell <b>${p.swHt.toFixed(1)} ft</b> · ${degToCompass(p.swDir)}
      </div>`;
    tip.style.display = 'block';
  }

  function hideTip() {
    tip.style.display = 'none';
    drawSwellChart(canvas, pts, null);
  }

  drawSwellChart(canvas, pts, null);

  canvas.addEventListener('touchstart', e => { e.preventDefault(); showTip(e.touches[0].clientX); }, { passive: false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); showTip(e.touches[0].clientX); }, { passive: false });
  canvas.addEventListener('touchend',   hideTip);
  canvas.addEventListener('mousemove',  e => showTip(e.clientX));
  canvas.addEventListener('mouseleave', hideTip);
}

// ─── Swell breakdown (stacked rows with direction arrows) ───────────────────

function swellBreakdownHTML(swells) {
  // Always show all components — don't filter by height. Sort longest period first.
  const sorted = [...swells]
    .filter(s => s.ht !== null && s.ht !== undefined)
    .sort((a, b) => b.per - a.per);

  if (!sorted.length) return '';

  const rows = sorted.map((s, i) => {
    const rotDeg = (s.dir + 180) % 360;
    const htStr = s.ht.toFixed(1);
    const isPrimary = i === 0;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;${i < sorted.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.05)' : ''}">
        <span style="font-size:${isPrimary ? '16px' : '14px'};font-weight:${isPrimary ? '700' : '500'};color:var(--text-primary);font-family:monospace;min-width:52px">${htStr}ft</span>
        <span style="font-size:${isPrimary ? '14px' : '13px'};color:var(--text-secondary);font-family:monospace;min-width:30px">${Math.round(s.per)}s</span>
        <span style="display:inline-block;transform:rotate(${rotDeg}deg);font-size:16px;line-height:1;color:#1e90ff">↑</span>
        <span style="font-size:13px;color:var(--text-secondary);font-family:monospace;min-width:36px">${degToCompass(s.dir)}</span>
        <span style="font-size:12px;color:var(--text-muted);font-family:monospace">${Math.round(s.dir)}°</span>
      </div>`;
  }).join('');

  return `
    <div style="margin-bottom:8px">
      <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;font-family:monospace">Swell Components</div>
      ${rows}
    </div>`;
}

// ─── Surf Quality Rating ──────────────────────────────────────────────────────
const QSTATE = { swell: null, windKts: null, windDir: null };
const EXTENDED_DATA = { swell: null, wind: null };

function evaluateQuality(swell, windKts, windDir, facing) {
  if (!swell || !(swell.ht > 0.3)) return { label: 'FLAT', score: 0, windType: null, consistency: null };

  const ht = swell.ht;
  const htS = ht < 0.5 ? 0 : ht < 1 ? 2 : ht < 2 ? 5 : ht < 4 ? 8 : ht < 8 ? 10 : ht < 12 ? 6 : 2;

  const per = swell.per ?? 0;
  const perS = per < 7 ? 0 : per < 10 ? 4 : per < 13 ? 7 : per < 16 ? 9 : 10;

  // Consistency: longer period = more organized swell = better wave sets
  const consistency = per >= 16 ? 'Very High' : per >= 13 ? 'High' : per >= 10 ? 'Moderate' : per >= 7 ? 'Low' : 'Very Low';

  // Wind scoring: combines speed + direction (onshore vs offshore)
  const ws = windKts ?? 0;
  const spdScore = ws < 5 ? 10 : ws < 10 ? 8 : ws < 15 ? 5 : ws < 20 ? 2 : 0;
  let windS, windType = null;

  if (facing != null && windDir != null) {
    // Offshore = wind blowing FROM land → ocean. Beach faces X°, offshore comes from (X+180)°
    const offshoreDir = (facing + 180) % 360;
    let wdDiff = Math.abs(windDir - offshoreDir);
    if (wdDiff > 180) wdDiff = 360 - wdDiff;

    windType = wdDiff < 45 ? 'Offshore' : wdDiff < 90 ? 'Side-offshore'
      : wdDiff < 135 ? 'Cross-shore' : wdDiff < 157 ? 'Side-onshore' : 'Onshore';

    const dirBonus = wdDiff < 45 ? 10 : wdDiff < 90 ? 7 : wdDiff < 135 ? 4 : wdDiff < 157 ? 1 : 0;

    // In light winds direction barely matters; in strong winds it's critical
    const dirWeight = ws < 5 ? 0.1 : ws < 10 ? 0.3 : 0.5;
    windS = spdScore * (1 - dirWeight) + dirBonus * dirWeight;
  } else {
    windS = spdScore;
  }

  let total;
  if (facing == null) {
    total = htS * 0.40 + perS * 0.35 + windS * 0.25;
  } else {
    let diff = Math.abs((swell.dir ?? 0) - facing);
    if (diff > 180) diff = 360 - diff;
    const dirS = diff < 20 ? 10 : diff < 45 ? 8 : diff < 70 ? 5 : diff < 90 ? 2 : 0;
    total = htS * 0.30 + perS * 0.25 + dirS * 0.20 + windS * 0.25;
  }

  const label = total < 2 ? 'FLAT' : total < 4 ? 'POOR' : total < 6 ? 'FAIR' : total < 8 ? 'GOOD' : 'EPIC';
  return { label, score: total, windType, consistency };
}

const QUALITY_COLORS = {
  FLAT: '#9e9e9e', POOR: '#ff5252', FAIR: '#ffb300', GOOD: '#00c853', EPIC: '#9b6dff',
};
const WIND_TYPE_COLORS = {
  'Offshore': '#00c853', 'Side-offshore': '#69f0ae', 'Cross-shore': '#ffeb3b',
  'Side-onshore': '#ff9800', 'Onshore': '#f44336',
};
const CONSISTENCY_COLORS = {
  'Very High': '#9b6dff', 'High': '#1e90ff', 'Moderate': '#00d4aa', 'Low': '#ffb300', 'Very Low': '#f44336',
};

function computePeakHours(swPts, wnPts, facing) {
  const hourlyQ = [];
  for (let i = 0; i < Math.min(swPts.length, 24); i++) {
    const sw = swPts[i];
    const hr = sw.t.getHours();
    if (hr < 5 || hr > 20) continue; // daylight only
    const swTime = sw.t.getTime();
    let wn = null;
    for (const w of wnPts) {
      if (Math.abs(w.t.getTime() - swTime) < 3600000) { wn = w; break; }
    }
    if (!wn) continue;
    const q = evaluateQuality({ ht: sw.swHt, per: sw.per, dir: sw.dir }, wn.spd, wn.dir, facing);
    hourlyQ.push({ t: sw.t, score: q.score, label: q.label });
  }
  if (hourlyQ.length < 3) return null;
  let bestAvg = -1, bestStart = 0;
  for (let i = 0; i <= hourlyQ.length - 3; i++) {
    const avg = (hourlyQ[i].score + hourlyQ[i + 1].score + hourlyQ[i + 2].score) / 3;
    if (avg > bestAvg) { bestAvg = avg; bestStart = i; }
  }
  const label = bestAvg < 2 ? 'FLAT' : bestAvg < 4 ? 'POOR' : bestAvg < 6 ? 'FAIR' : bestAvg < 8 ? 'GOOD' : 'EPIC';
  return { start: hourlyQ[bestStart].t, end: hourlyQ[bestStart + 2].t, score: bestAvg, label };
}

function renderQuality() {
  if (!QSTATE.swell) return;
  const q = evaluateQuality(QSTATE.swell, QSTATE.windKts, QSTATE.windDir, BEACH_FACING());
  const color = QUALITY_COLORS[q.label];

  const slot = document.getElementById('buoy-quality');
  if (!slot) return;
  const pct = Math.round(q.score * 10);

  slot.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span style="font-size:18px;font-weight:bold;font-family:monospace;color:${color}">${q.label}</span>
      <span style="font-size:11px;color:var(--text-secondary);font-family:monospace">${q.score.toFixed(1)}/10</span>
    </div>
    <div style="height:4px;border-radius:2px;background:rgba(155,155,155,0.15);overflow:hidden">
      <div style="width:${pct}%;height:100%;border-radius:2px;background:${color}"></div>
    </div>`;

  const badge = document.getElementById('buoy-badge');
  if (badge) {
    badge.textContent = q.label;
    badge.style.color = color;
    badge.style.background = color + '26';
  }
}

// ─── 2. Open-Meteo Marine (Swell Forecast) ────────────────────────────────────
async function loadSwell() {
  try {
    // Fetch primary model (ECMWF WAM4) and secondary model (NCEP GFS Wave) in parallel
    const baseParams = `latitude=${LAT()}&longitude=${LNG()}`
      + `&hourly=wave_height,wave_period,wave_direction,wind_wave_height,wind_wave_direction,wind_wave_period,swell_wave_height,swell_wave_period,swell_wave_direction,secondary_swell_wave_height,secondary_swell_wave_period,secondary_swell_wave_direction`
      + `&wind_speed_unit=kn&length_unit=imperial&timezone=auto&forecast_days=7`;
    const [res, altRes] = await Promise.all([
      fetch(`https://marine-api.open-meteo.com/v1/marine?${baseParams}&models=ecmwf_wam025`),
      fetch(`https://marine-api.open-meteo.com/v1/marine?${baseParams}&models=ncep_gfswave025`).catch(() => null),
    ]);
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
    let swHt  = d.hourly.swell_wave_height[idx];
    let swPer = d.hourly.swell_wave_period[idx];
    let swDir = d.hourly.swell_wave_direction[idx];
    let wwHt  = d.hourly.wind_wave_height[idx];
    let wwPer = d.hourly.wind_wave_period[idx];
    let wwDir = d.hourly.wind_wave_direction[idx];
    let sw2Ht  = d.hourly.secondary_swell_wave_height?.[idx] ?? null;
    let sw2Per = d.hourly.secondary_swell_wave_period?.[idx] ?? null;
    let sw2Dir = d.hourly.secondary_swell_wave_direction?.[idx] ?? null;

    // ECMWF WAM 0.25 doesn't decompose into swell/wind-wave components.
    // Use GFS (altData) for swell decomposition when primary returns null.
    let altIdx = 0;
    let altData = null;
    try {
      if (altRes?.ok) altData = await altRes.json();
    } catch (e) {}

    if (altData?.hourly?.time) {
      const altHours = altData.hourly.time;
      for (let i = 0; i < altHours.length; i++) {
        if (new Date(altHours[i]) <= now) altIdx = i;
      }
    }

    if (swHt == null && altData?.hourly?.swell_wave_height) {
      swHt  = altData.hourly.swell_wave_height[altIdx] ?? null;
      swPer = altData.hourly.swell_wave_period?.[altIdx] ?? null;
      swDir = altData.hourly.swell_wave_direction?.[altIdx] ?? null;
    }
    if (wwHt == null && altData?.hourly?.wind_wave_height) {
      wwHt  = altData.hourly.wind_wave_height?.[altIdx] ?? null;
      wwPer = altData.hourly.wind_wave_period?.[altIdx] ?? null;
      wwDir = altData.hourly.wind_wave_direction?.[altIdx] ?? null;
    }
    if (sw2Ht == null && altData?.hourly?.secondary_swell_wave_height) {
      sw2Ht  = altData.hourly.secondary_swell_wave_height?.[altIdx] ?? null;
      sw2Per = altData.hourly.secondary_swell_wave_period?.[altIdx] ?? null;
      sw2Dir = altData.hourly.secondary_swell_wave_direction?.[altIdx] ?? null;
    }

    // Last resort: use total wave height as swell proxy
    if (swHt == null) { swHt = wvHt; swPer = wvPer; swDir = wvDir; }

    // Model spread: compare ECMWF vs GFS at current hour
    let modelSpread = null;
    if (altData?.hourly?.wave_height) {
      const altWvHt = altData.hourly.wave_height[altIdx];
      if (altWvHt != null && wvHt != null) {
        const lo = Math.min(wvHt, altWvHt);
        const hi = Math.max(wvHt, altWvHt);
        const diff = Math.abs(wvHt - altWvHt);
        const confidence = diff < 0.5 ? 'High' : diff < 1.5 ? 'Medium' : 'Low';
        modelSpread = { lo, hi, diff, confidence };
      }
    }

    const dirStr   = degToCompass(wvDir);
    const swDirStr = degToCompass(swDir);

    QSTATE.swell = { ht: swHt, per: swPer, dir: swDir };
    renderQuality();

    // ── Helper: prefer ECMWF value, fall back to GFS, then total wave ──
    const altH = altData?.hourly;
    const sw = (field, i) => d.hourly[field]?.[i] ?? altH?.[field]?.[Math.min(i, (altH?.time?.length ?? 1) - 1)] ?? null;

    // ── Collect 48-hour forecast points ────────────────────────────────────
    const pts = [];
    for (let i = idx; i < hours.length && pts.length < 48; i++) {
      pts.push({
        t:    new Date(hours[i]),
        wvHt: d.hourly.wave_height[i] ?? 0,
        swHt: sw('swell_wave_height', i) ?? d.hourly.wave_height[i] ?? 0,
        per:  d.hourly.wave_period[i] ?? 0,
        dir:  d.hourly.wave_direction[i] ?? 0,
        swDir: sw('swell_wave_direction', i) ?? d.hourly.wave_direction[i] ?? 0,
      });
    }

    // ── Collect all 7-day hourly points for extended outlook ──────────────
    const allSwellPts = [];
    for (let i = idx; i < hours.length; i++) {
      allSwellPts.push({
        t:    new Date(hours[i]),
        wvHt: d.hourly.wave_height[i] ?? 0,
        swHt: sw('swell_wave_height', i) ?? d.hourly.wave_height[i] ?? 0,
        per:  sw('swell_wave_period', i) ?? d.hourly.wave_period[i] ?? 0,
        dir:  sw('swell_wave_direction', i) ?? d.hourly.wave_direction[i] ?? 0,
      });
    }
    EXTENDED_DATA.swell = allSwellPts;
    render7DayOutlook();
    render24HourHeatmap();

    // Direction table — every 3 hours, next 24 hours
    const dirSamples = [];
    for (let i = 0; i < pts.length && dirSamples.length < 8; i++) {
      if (i === 0 || pts[i].t.getHours() % 3 === 0) dirSamples.push(pts[i]);
    }
    const dirRows = dirSamples.map(p => `
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1">
        <span style="font-size:9px;color:var(--text-muted);font-family:monospace">${fmtTime(p.t).replace(':00','')}</span>
        <span style="display:inline-block;transform:rotate(${p.dir + 180}deg);font-size:14px;line-height:1;color:#1e90ff">↑</span>
        <span style="font-size:9px;font-family:monospace;color:var(--text-muted)">${degToCompass(p.dir)}</span>
        <span style="font-size:10px;font-weight:bold;font-family:monospace;color:#1e90ff">${p.wvHt.toFixed(1)}</span>
        <span style="font-size:9px;font-family:monospace;color:#00d4aa">${p.per.toFixed(0)}s</span>
      </div>`).join('');

    const dirTable = `<div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;font-family:monospace">Swell Outlook · ft &amp; period</div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:6px">${dirRows}</div>`;

    const srcLink = `<a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noopener" class="src-link">ECMWF WAM4 via Open-Meteo ↗</a>`;

    const legend = `<div style="display:flex;gap:12px;margin-bottom:4px;font-size:9px;color:var(--text-muted);font-family:monospace">
      <span><span style="display:inline-block;width:14px;height:2px;background:#1e90ff;vertical-align:middle;margin-right:3px"></span>Wave (ft)</span>
      <span><span style="display:inline-block;width:14px;height:0;border-top:1.5px dashed #00d4aa;vertical-align:middle;margin-right:3px"></span>Swell (ft)</span>
    </div>`;

    // Forecast accuracy - use buoy observations when available, not model data
    const actualWvHt = _ndbcWave ? _ndbcWave.heightFt : null;
    const actualPer  = _ndbcWave ? _ndbcWave.period : null;
    const actualWindSpd = _ndbcWind ? _ndbcWind.speedKts : null;
    const accuracy = checkForecastAccuracy(ACTIVE.id, actualWvHt, actualPer, actualWindSpd);
    storeForecastSnapshot(ACTIVE.id, pts, EXTENDED_DATA.wind);

    const accParts = [];
    if (accuracy) {
      if (accuracy.waveHt !== null) accParts.push(`Wave ${accuracy.waveHt}%`);
      if (accuracy.period !== null) accParts.push(`Period ${accuracy.period}%`);
      if (accuracy.wind   !== null) accParts.push(`Wind ${accuracy.wind}%`);
    }
    const accuracyBadge = accParts.length
      ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px">📊 Forecast vs buoy: ${accParts.join(' · ')} (${accuracy.samples} samples)</div>`
      : '';

    const spreadBadge = modelSpread
      ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">🔀 Models: ${modelSpread.lo.toFixed(1)}-${modelSpread.hi.toFixed(1)}ft · ${modelSpread.confidence} confidence</div>`
      : '';

    setHTML('swell-body', `
      <div class="swell-compass">
        <div class="compass-rose" title="${wvDir}°">
          <span style="display:inline-block;transform:rotate(${(wvDir + 180) % 360}deg);font-size:22px">↑</span>
        </div>
        <div>
          <div class="stat-row">
            <span class="stat-value" style="color:#1e90ff">${wvHt?.toFixed(1) ?? '—'}</span>
            <span class="stat-unit">ft</span>
          </div>
          <div class="stat-label">${wvPer?.toFixed(0) ?? '—'}s period · from ${dirStr} (${wvDir}°) · ECMWF WAM4</div>
        </div>
      </div>
      ${swellAlignmentHTML(swDir, BEACH_FACING())}
      ${swellBreakdownHTML([
        { ht: swHt, per: swPer, dir: swDir },
        ...(sw2Ht !== null ? [{ ht: sw2Ht, per: sw2Per, dir: sw2Dir }] : []),
        { ht: wwHt, per: wwPer, dir: wwDir },
      ])}
      ${swellArrivalHTML(swPer)}
      ${spreadBadge}
      ${accuracyBadge}
      <div class="divider"></div>
      ${legend}
      <div style="position:relative;margin-bottom:6px">
        <canvas id="swell-chart-canvas" height="80" style="width:100%;height:80px;display:block;touch-action:none;cursor:crosshair"></canvas>
        <div id="swell-chart-tip" style="display:none;position:absolute;top:6px;left:0;background:rgba(10,22,40,0.92);border:1px solid rgba(30,144,255,0.4);border-radius:6px;padding:6px 9px;pointer-events:none;min-width:130px;max-width:160px"></div>
      </div>
      ${dirTable}
      <div class="buoy-source" style="margin-top:6px">${srcLink}</div>
    `);
    setupSwellChart(pts);
  } catch (e) {
    setHTML('swell-body', errorHTML('Swell data unavailable: ' + e.message));
  }
}

// ─── 3. Open-Meteo Weather (Wind) ─────────────────────────────────────────────
async function loadWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT()}&longitude=${LNG()}`
      + `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m`
      + `&wind_speed_unit=kn&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const now = new Date();
    const hours = d.hourly.time;
    let idx = 0;
    for (let i = 0; i < hours.length; i++) {
      if (new Date(hours[i]) <= now) idx = i;
    }

    // Use NDBC observed wind for current if available, otherwise model
    if (_ndbcWind && _ndbcWind.speedKts != null) {
      renderWind(_ndbcWind.speedKts, _ndbcWind.gustKts, _ndbcWind.dir, true);
    } else {
      renderWind(d.hourly.wind_speed_10m[idx], d.hourly.wind_gusts_10m[idx], d.hourly.wind_direction_10m[idx], false);
    }
    renderWindForecast(d.hourly, idx);

    const windPts = [];
    for (let i = idx; i < hours.length && windPts.length < 48; i++) {
      windPts.push({ t: new Date(hours[i]), spd: d.hourly.wind_speed_10m[i] ?? 0, gst: d.hourly.wind_gusts_10m[i] ?? 0, dir: d.hourly.wind_direction_10m[i] ?? 0 });
    }
    // ── Collect all 7-day hourly wind points for extended outlook ──────
    const allWindPts = [];
    for (let i = idx; i < hours.length; i++) {
      allWindPts.push({ t: new Date(hours[i]), spd: d.hourly.wind_speed_10m[i] ?? 0, gst: d.hourly.wind_gusts_10m[i] ?? 0, dir: d.hourly.wind_direction_10m[i] ?? 0 });
    }
    EXTENDED_DATA.wind = allWindPts;
    render7DayOutlook();
    render24HourHeatmap();

    QSTATE.windKts = d.hourly.wind_speed_10m[idx] ?? null;
    QSTATE.windDir = d.hourly.wind_direction_10m[idx] ?? null;
    renderQuality();
  } catch (e) {
    setHTML('wind-body', '<span style="color:#ff5252;font-size:10px">Wind unavailable</span>');
    setHTML('wind-forecast-body', errorHTML('Wind forecast unavailable'));
  }
}

function renderWindForecast(hourly, currentIdx) {
  const times  = hourly.time;
  const speeds = hourly.wind_speed_10m;
  const gusts  = hourly.wind_gusts_10m;
  const dirs   = hourly.wind_direction_10m;

  // Collect next 48 hours of data
  const pts = [];
  for (let i = currentIdx; i < times.length && pts.length < 48; i++) {
    pts.push({ t: new Date(times[i]), spd: speeds[i] ?? 0, gst: gusts[i] ?? 0, dir: dirs[i] ?? 0 });
  }
  if (pts.length < 2) { setHTML('wind-forecast-body', errorHTML('Not enough forecast data')); return; }

  // ── SVG chart (speed + gusts) ────────────────────────────────────────────
  const W = 320, H = 72, PL = 32, PR = 6, PT = 6, PB = 14;
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

  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;margin-bottom:6px">
    ${yLabels}${xLabels}${nowLine}
    <path d="${areaPath}" fill="rgba(0,200,83,0.15)"/>
    <polyline points="${speedPts}" fill="none" stroke="#00c853" stroke-width="1.5" stroke-linejoin="round"/>
    <polyline points="${gustPts}"  fill="none" stroke="#ffeb3b" stroke-width="1"   stroke-linejoin="round" stroke-dasharray="3,2"/>
  </svg>`;

  // Legend
  const legend = `<div style="display:flex;gap:12px;margin-bottom:4px;font-size:9px;color:var(--text-muted);font-family:monospace">
    <span><span style="display:inline-block;width:14px;height:2px;background:#00c853;vertical-align:middle;margin-right:3px"></span>Speed</span>
    <span><span style="display:inline-block;width:14px;height:1px;background:#ffeb3b;vertical-align:middle;margin-right:3px;border-top:1px dashed #ffeb3b"></span>Gusts</span>
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

  const dirTable = `<div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;font-family:monospace">Direction Outlook · kts</div>
    <div style="display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:6px">${dirRows}</div>`;

  setHTML('wind-forecast-body', legend
    + `<div id="wind-chart-container" class="wind-chart-container" style="position:relative;margin-bottom:6px">${svg}<div id="wind-chart-tip" class="wind-chart-tip"></div></div>`
    + dirTable
    + `<div class="buoy-source"><a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener" class="src-link">Open-Meteo Weather API ↗</a></div>`);
  setupWindChartInteraction(pts);
}

function renderWind(speedKts, gustKts, dir, isObserved) {
  const [cls, desc] = windClass(speedKts);
  const dirStr = degToCompass(dir);

  const windColors = {
    'wind-calm':   '#00c853',
    'wind-light':  '#69f0ae',
    'wind-mod':    '#ffeb3b',
    'wind-fresh':  '#ff9800',
    'wind-strong': '#f44336',
    'wind-gale':   '#b71c1c',
  };
  const wc = windColors[cls];
  const sourceTag = isObserved ? 'Observed' : 'Model';

  // Update wind badge
  setBadge('wind-badge', desc.toUpperCase(), wc, wc + '26');

  setHTML('wind-body', `
    <div class="stat-row">
      <span class="stat-value" style="color:${wc}">${speedKts?.toFixed(0) ?? '—'}</span>
      <span class="stat-unit">kts</span>
    </div>
    <div class="stat-label">${desc} · ${sourceTag}</div>
    <div style="margin-top:6px;font-size:11px;font-family:monospace;color:var(--text-secondary)">
      <div>from ${dirStr} <span style="color:var(--text-muted)">${dir}°</span></div>
      <div style="margin-top:3px">gusts ${gustKts?.toFixed(0) ?? '—'} kts</div>
    </div>
  `);
}

// ─── 4. NOAA Tides ────────────────────────────────────────────────────────────
async function loadTides() {
  if (!ACTIVE?.tideStation) return;

  try {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + (_tideRange === 'extended' ? 2 : 1));
    const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
      + `?begin_date=${fmtDate(today)}&end_date=${fmtDate(endDate)}&station=${NOAA_STATION()}`
      + `&datum=MLLW&time_zone=lst_ldt&units=english&application=web_services&format=json`;

    const [hourlyRes, hiloRes, observedRes] = await Promise.all([
      fetch(base + '&product=predictions&interval=h'),
      fetch(base + '&product=predictions&interval=hilo'),
      fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
        + `?date=latest&station=${NOAA_STATION()}&product=water_level&datum=MLLW`
        + `&time_zone=lst_ldt&units=english&application=web_services&format=json`),
    ]);
    if (!hourlyRes.ok || !hiloRes.ok) throw new Error('HTTP error');
    const [hourlyData, hiloData] = await Promise.all([hourlyRes.json(), hiloRes.json()]);
    if (hourlyData.error) throw new Error(hourlyData.error.message);
    if (hiloData.error) throw new Error(hiloData.error.message);

    // Parse observed water level (may fail - not critical)
    let observedLevel = null;
    try {
      const obsData = await observedRes.json();
      if (obsData.data?.length) {
        observedLevel = parseFloat(obsData.data[obsData.data.length - 1].v);
      }
    } catch (e) {}

    // NOAA returns "YYYY-MM-DD HH:MM" — replace space with T for mobile compat
    const parseNoaaDate = s => new Date(s.replace(' ', 'T'));

    const hourly = hourlyData.predictions.map(p => ({ t: parseNoaaDate(p.t), v: parseFloat(p.v) }));
    const events = hiloData.predictions.map(p => ({ t: parseNoaaDate(p.t), v: parseFloat(p.v), type: p.type }));
    const now = new Date();

    // ── SVG tide chart ──────────────────────────────────────────────────────
    const W = 320, H = 110, PL = 30, PR = 8, PT = 12, PB = 20;
    const chartW = W - PL - PR, chartH = H - PT - PB;

    const lookAhead = _tideRange === 'extended' ? 42 : 18;
    const tStart = new Date(now.getTime() - 6 * 3600000);
    const tEnd   = new Date(now.getTime() + lookAhead * 3600000);

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
    // Use observed water level if available, otherwise interpolate from predictions
    const predictedV = (() => {
      for (let i = 1; i < visible.length; i++) {
        if (visible[i].t >= now) {
          const frac = (now - visible[i-1].t) / (visible[i].t - visible[i-1].t);
          return visible[i-1].v + frac * (visible[i].v - visible[i-1].v);
        }
      }
      return visible[visible.length-1].v;
    })();
    const nowV = observedLevel !== null ? observedLevel : predictedV;
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

    const sched24End = new Date(now.getTime() + 24 * 3600000);
    const scheduleHTML = events
      .filter(e => e.t >= now && e.t <= sched24End)
      .map(e => {
        const isHigh = e.type === 'H';
        const isPast = e.t < now;
        return `
          <div class="tide-event${isPast ? ' past' : ''}">
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

    const toggleLabel = _tideRange === 'extended' ? '24h' : '48h';
    const toggleActive = _tideRange === 'extended' ? ' active' : '';

    const tideSource = observedLevel !== null ? 'Observed' : 'Predicted';
    setHTML('tides-body', `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:18px;font-weight:700;color:#1e90ff">${nowV.toFixed(2)}<span style="font-size:11px;color:var(--text-muted)"> ft ${tideSource.toLowerCase()}</span></span>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text-secondary)">${trend}</span>
          <button class="tide-toggle${toggleActive}" onclick="toggleTideRange()">${toggleLabel}</button>
        </div>
      </div>
      ${svg}
      <div class="buoy-source" style="margin-top:6px"><a href="https://tidesandcurrents.noaa.gov/waterlevels.html?id=${NOAA_STATION()}" target="_blank" rel="noopener" class="src-link">NOAA Tides & Currents · ${tideSource} ↗</a></div>
    `);

    // ── Tide graph inside wind card ────────────────────────────────────────
    const miniEl = document.getElementById('tide-mini');
    if (miniEl) {
      // Build a compact 24h tide chart (6h back, 18h ahead)
      const mW = 280, mH = 70, mPL = 22, mPR = 4, mPT = 10, mPB = 14;
      const mCW = mW - mPL - mPR, mCH = mH - mPT - mPB;
      const mStart = new Date(now.getTime() - 6 * 3600000);
      const mEnd   = new Date(now.getTime() + 18 * 3600000);
      const mPts   = hourly.filter(p => p.t >= mStart && p.t <= mEnd);

      if (mPts.length >= 2) {
        const mVals = mPts.map(p => p.v);
        const mMin = Math.min(...mVals) - 0.3;
        const mMax = Math.max(...mVals) + 0.3;
        const mTR = mEnd - mStart;
        const mtx = t => mPL + ((t - mStart) / mTR) * mCW;
        const mty = v => mPT + (1 - (v - mMin) / (mMax - mMin)) * mCH;

        const mPtsXY = mPts.map(p => [mtx(p.t), mty(p.v)]);
        let mPathD = `M ${mPtsXY[0][0].toFixed(1)},${mPtsXY[0][1].toFixed(1)}`;
        for (let i = 1; i < mPtsXY.length; i++) {
          const cpx = (mPtsXY[i-1][0] + mPtsXY[i][0]) / 2;
          mPathD += ` C ${cpx.toFixed(1)},${mPtsXY[i-1][1].toFixed(1)} ${cpx.toFixed(1)},${mPtsXY[i][1].toFixed(1)} ${mPtsXY[i][0].toFixed(1)},${mPtsXY[i][1].toFixed(1)}`;
        }
        const mFillD = mPathD
          + ` L ${mPtsXY[mPtsXY.length-1][0].toFixed(1)},${(mPT + mCH).toFixed(1)}`
          + ` L ${mPtsXY[0][0].toFixed(1)},${(mPT + mCH).toFixed(1)} Z`;

        const mNowX = mtx(now).toFixed(1);
        const mNowY = mty(nowV).toFixed(1);

        // Hi/lo markers within the 24h window
        const mEvents = events.filter(e => e.t >= mStart && e.t <= mEnd);
        const mMarkers = mEvents.map(e => {
          const ex = mtx(e.t).toFixed(1);
          const ey = mty(e.v).toFixed(1);
          const isHigh = e.type === 'H';
          const color = isHigh ? '#9b6dff' : '#1e90ff';
          const ly = isHigh ? (parseFloat(ey) - 5).toFixed(1) : (parseFloat(ey) + 9).toFixed(1);
          const timeStr = e.t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '');
          return `<circle cx="${ex}" cy="${ey}" r="2.5" fill="${color}" stroke="#0f1f3d" stroke-width="1"/>
            <text x="${ex}" y="${ly}" text-anchor="middle" font-size="6" fill="${color}" font-weight="600">${e.v.toFixed(1)}ft ${timeStr}</text>`;
        }).join('');

        // Time labels
        let mXLabels = '';
        for (let h = 0; h <= 24; h += 6) {
          const t = new Date(mStart.getTime() + h * 3600000);
          const x = mtx(t).toFixed(1);
          const lbl = t.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' ', '');
          mXLabels += `<text x="${x}" y="${(mH - 3).toFixed(1)}" text-anchor="middle" font-size="6" fill="#4a7a96">${lbl}</text>`;
        }

        miniEl.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">
            <span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">24h Tides</span>
            <span style="font-size:11px;color:#1e90ff;font-weight:600">${nowV.toFixed(1)}ft <span style="font-weight:400;color:var(--text-muted)">${trend}</span></span>
          </div>
          <svg viewBox="0 0 ${mW} ${mH}" width="100%" style="display:block;overflow:visible">
            <defs><linearGradient id="tideFillMini" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#1e90ff" stop-opacity="0.2"/>
              <stop offset="100%" stop-color="#1e90ff" stop-opacity="0.02"/>
            </linearGradient></defs>
            <path d="${mFillD}" fill="url(#tideFillMini)"/>
            <path d="${mPathD}" fill="none" stroke="#1e90ff" stroke-width="1.5" stroke-linejoin="round"/>
            <line x1="${mNowX}" y1="${mPT}" x2="${mNowX}" y2="${mPT + mCH}" stroke="#00d4aa" stroke-width="1" stroke-dasharray="2,2"/>
            <circle cx="${mNowX}" cy="${mNowY}" r="3" fill="#00d4aa" stroke="#0f1f3d" stroke-width="1"/>
            ${mMarkers}
            ${mXLabels}
          </svg>`;
      }
    }
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
        <div style="margin-bottom:6px">
          <div style="font-size:11px;font-weight:600;color:var(--accent-blue);margin-bottom:2px">${escapeHtml(title)}</div>
          <div class="forecast-text">${escapeHtml(detail)}</div>
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
        <div class="rip-level ${ripLevel}">${escapeHtml(levelLabel)}</div>
        <div class="rip-desc">${escapeHtml(ripText.substring(0, 200))}${ripText.length > 200 ? '…' : ''}</div>
      </div>
      <div class="buoy-source" style="margin-top:8px"><a href="https://www.weather.gov/mtr/rip" target="_blank" rel="noopener" class="src-link">NWS Rip Current Outlook ↗</a></div>
    `);
  } catch (e) {
    setHTML('rip-body', errorHTML('Rip current data unavailable: ' + e.message));
  }
}

// ─── 7. Sun & Moon ────────────────────────────────────────────────────────────
async function loadSunrise() {
  try {
    const res = await fetch(`https://api.sunrise-sunset.org/json?lat=${LAT()}&lng=${LNG()}&formatted=0`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (d.status !== 'OK') throw new Error(d.status);
    const r = d.results;

    const sunrise    = new Date(r.sunrise);
    const sunset     = new Date(r.sunset);
    const firstLight = new Date(r.civil_twilight_begin);
    const lastLight  = new Date(r.civil_twilight_end);

    const goldenAMEnd   = new Date(sunrise.getTime() + 3600000);
    const goldenPMStart = new Date(sunset.getTime()  - 3600000);

    const dayMins = (sunset - sunrise) / 60000;
    const dayH    = Math.floor(dayMins / 60);
    const dayM    = Math.round(dayMins % 60);

    const moon     = getMoonPhase();
    const isSpring = (moon.phase < 3.7 || moon.phase > 25.8) || (moon.phase > 12.9 && moon.phase < 16.6);

    setHTML('sun-moon-body', `
      <div class="sun-moon-grid">
        <div class="sun-section">
          <div class="section-label">☀️ Sun</div>
          <div class="sun-times">
            <div class="time-row"><span class="lbl">First Light</span><span class="val">${fmtTime(firstLight)}</span></div>
            <div class="time-row"><span class="lbl">Sunrise</span><span class="val">${fmtTime(sunrise)}</span></div>
            <div class="time-row"><span class="lbl">Sunset</span><span class="val">${fmtTime(sunset)}</span></div>
            <div class="time-row"><span class="lbl">Last Light</span><span class="val">${fmtTime(lastLight)}</span></div>
            <div class="time-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px">
              <span class="lbl">Day Length</span><span class="val">${dayH}h ${dayM}m</span>
            </div>
          </div>
          <div style="margin-top:8px;font-size:10px;color:var(--text-muted)">
            <div>🌅 ${fmtTime(sunrise)}–${fmtTime(goldenAMEnd)}</div>
            <div>🌇 ${fmtTime(goldenPMStart)}–${fmtTime(sunset)}</div>
          </div>
        </div>
        <div class="moon-section">
          <div class="section-label">🌙 Moon</div>
          <div class="moon-info">
            <div class="moon-phase-icon">${moon.icon}</div>
            <div class="moon-phase-name">${moon.name}</div>
            <div style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:4px">
              ${Math.round(moon.fraction * 100)}% illuminated
            </div>
            <div style="font-size:10px;color:var(--text-muted);text-align:center;margin-top:2px">
              ${moon.daysToFull === 0 ? 'Full moon tonight' : moon.daysToFull + 'd to full moon'}
            </div>
            <div style="font-size:10px;color:var(--accent-purple);text-align:center;margin-top:4px">
              ${isSpring ? '🌊 Spring tides (larger range)' : '〰️ Neap tides (smaller range)'}
            </div>
          </div>
        </div>
      </div>
    `);
  } catch (e) {
    setHTML('sun-moon-body', errorHTML('Sun data unavailable: ' + e.message));
  }
}

// ─── 8. UV Index ──────────────────────────────────────────────────────────────
async function loadUV() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT()}&longitude=${LNG()}`
      + `&current=uv_index&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const uv = d.current.uv_index;

    let level, color, bg;
    if (uv < 3)       { level = 'Low';       color = '#00c853'; bg = 'rgba(0,200,83,0.15)'; }
    else if (uv < 6)  { level = 'Moderate';  color = '#ffeb3b'; bg = 'rgba(255,235,59,0.15)'; }
    else if (uv < 8)  { level = 'High';      color = '#ff9800'; bg = 'rgba(255,152,0,0.15)'; }
    else if (uv < 11) { level = 'Very High'; color = '#f44336'; bg = 'rgba(244,67,54,0.15)'; }
    else               { level = 'Extreme';  color = '#9c27b0'; bg = 'rgba(156,39,176,0.15)'; }

    setBadge('uv-badge', level.toUpperCase(), color, bg);

    const pct = Math.min(100, (uv / 12) * 100);
    setHTML('uv-body', `
      <div style="display:flex;align-items:baseline;gap:5px;margin-bottom:3px">
        <span style="font-size:24px;font-weight:700;color:${color}">${uv.toFixed(1)}</span>
        <span style="font-size:12px;color:var(--text-secondary)">${level}</span>
      </div>
      <div class="uv-bar-wrap">
        <div class="uv-bar-track">
          <div class="uv-bar-dot" style="left:${pct}%"></div>
        </div>
        <div class="uv-labels">
          <span>Low</span><span>Moderate</span><span>High</span><span>Very High</span><span>Extreme</span>
        </div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:3px">
        ${uv >= 6 ? '🧴 Sunscreen recommended' : uv >= 3 ? '🕶️ Sun protection advised' : '✓ Low exposure risk'}
      </div>
    `);
  } catch (e) {
    setHTML('uv-body', errorHTML('UV data unavailable: ' + e.message));
  }
}

// ─── Swell-Beach Alignment ───────────────────────────────────────────────────
function swellAlignmentHTML(swellDir, beachFacing) {
  if (beachFacing == null || swellDir == null) return '';

  let diff = Math.abs(swellDir - beachFacing);
  if (diff > 180) diff = 360 - diff;

  let quality, color, label;
  if (diff < 30)      { quality = 'Optimal'; color = '#00c853'; label = 'Direct hit'; }
  else if (diff < 45) { quality = 'Good';    color = '#69f0ae'; label = 'Good angle'; }
  else if (diff < 70) { quality = 'Fair';    color = '#ffeb3b'; label = 'Angled'; }
  else if (diff < 90) { quality = 'Poor';    color = '#ff9800'; label = 'Oblique'; }
  else                { quality = 'Shadow';  color = '#f44336'; label = 'Shadowed'; }

  return `
    <div class="alignment-badge">
      <div class="alignment-compass" style="border:2px solid ${color}">
        <span class="swell-arrow" style="transform:rotate(${(swellDir + 180) % 360}deg)">↑</span>
        <span class="beach-line" style="transform:rotate(${beachFacing}deg);color:${color}">━</span>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:${color}">${quality} Alignment</div>
        <div style="font-size:9px;color:var(--text-muted)">${label} · ${Math.round(diff)}° off beach (${Math.round(beachFacing)}°)</div>
      </div>
    </div>`;
}

// ─── Swell Arrival Estimation ────────────────────────────────────────────────
function swellArrivalHTML(period) {
  if (!period || period < 12) return '';
  const speedKn = 1.56 * period;
  const distNM  = 2500;
  const hours   = distNM / speedKn;
  if (period >= 16) {
    return `<div style="font-size:10px;color:var(--accent-purple);margin-top:4px">
      🌏 Long-period groundswell · ~${speedKn.toFixed(0)} kts wave speed · ~${Math.round(hours / 24)}d travel from NP storm</div>`;
  }
  return `<div style="font-size:10px;color:var(--accent-blue);margin-top:4px">
    🌊 Groundswell · ~${speedKn.toFixed(0)} kts wave speed</div>`;
}

// ─── Forecast Accuracy Tracking ──────────────────────────────────────────────
function storeForecastSnapshot(spotId, swellPts, windPts) {
  if (!swellPts || swellPts.length < 7) return;
  try {
    const key = 'forecast_history_' + spotId;
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    const entry = {
      storedAt: Date.now(),
      targetTime: swellPts[6].t.getTime(),
      forecastWvHt: swellPts[6].wvHt,
      forecastPer:  swellPts[6].per,
    };
    // Attach wind forecast if available at same time index
    if (windPts && windPts.length > 6) {
      entry.forecastWindSpd = windPts[6].spd;
    }
    history.push(entry);
    if (history.length > 30) history.splice(0, history.length - 30);
    localStorage.setItem(key, JSON.stringify(history));
  } catch (e) {}
}

function checkForecastAccuracy(spotId, actualWvHt, actualPer, actualWindSpd) {
  try {
    const key = 'forecast_history_' + spotId;
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    const now = Date.now();
    const expired = history.filter(e => e.targetTime < now && e.targetTime > now - 7200000 && !e.verified);
    if (!expired.length) return null;

    const forecast = expired[expired.length - 1];
    forecast.verified = true;

    // Wave height accuracy
    if (actualWvHt != null && forecast.forecastWvHt > 0) {
      const pctErr = (Math.abs(forecast.forecastWvHt - actualWvHt) / forecast.forecastWvHt) * 100;
      forecast.wvHtAccuracy = Math.max(0, 100 - pctErr);
    }
    // Period accuracy
    if (actualPer != null && forecast.forecastPer > 0) {
      const pctErr = (Math.abs(forecast.forecastPer - actualPer) / forecast.forecastPer) * 100;
      forecast.perAccuracy = Math.max(0, 100 - pctErr);
    }
    // Wind speed accuracy
    if (actualWindSpd != null && forecast.forecastWindSpd > 0) {
      const pctErr = (Math.abs(forecast.forecastWindSpd - actualWindSpd) / forecast.forecastWindSpd) * 100;
      forecast.windAccuracy = Math.max(0, 100 - pctErr);
    }
    // Backward compat
    forecast.accuracy = forecast.wvHtAccuracy ?? null;

    localStorage.setItem(key, JSON.stringify(history));

    const verified = history.filter(e => e.verified);
    if (!verified.length) return null;

    const avg = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    return {
      waveHt: avg(verified.filter(e => e.wvHtAccuracy != null).map(e => e.wvHtAccuracy)),
      period: avg(verified.filter(e => e.perAccuracy != null).map(e => e.perAccuracy)),
      wind:   avg(verified.filter(e => e.windAccuracy != null).map(e => e.windAccuracy)),
      samples: verified.length,
      // Legacy compat
      accuracy: avg(verified.filter(e => e.wvHtAccuracy != null).map(e => e.wvHtAccuracy)),
    };
  } catch (e) { return null; }
}

// ─── Wind Chart Touch Interaction ────────────────────────────────────────────
function setupWindChartInteraction(pts) {
  const container = document.getElementById('wind-chart-container');
  const tip       = document.getElementById('wind-chart-tip');
  if (!container || !tip) return;

  const SVG_W = 320, PL = 32, PR = 6;
  const tStart = pts[0].t.getTime(), tEnd = pts[pts.length - 1].t.getTime(), tRange = tEnd - tStart;

  function idxFromX(clientX) {
    const rect = container.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1,
      ((clientX - rect.left) / rect.width - PL / SVG_W) / ((SVG_W - PL - PR) / SVG_W)));
    const tgt = tStart + frac * tRange;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i].t.getTime() - tgt); if (d < bestD) { bestD = d; best = i; } }
    return best;
  }

  function show(clientX) {
    const i = idxFromX(clientX), p = pts[i];
    const rect = container.getBoundingClientRect();
    const x = ((p.t.getTime() - tStart) / tRange * ((SVG_W - PL - PR) / SVG_W) + PL / SVG_W) * rect.width;
    const tipW = tip.offsetWidth || 140;
    tip.style.left = (x > rect.width / 2 ? Math.max(0, x - tipW - 8) : x + 10) + 'px';

    const [, desc] = windClass(p.spd);
    tip.innerHTML = `
      <div style="font-size:10px;color:#00c853;font-family:monospace;margin-bottom:3px">${fmtTime(p.t)} ${p.t.toLocaleDateString([], { weekday: 'short' })}</div>
      <div style="font-size:12px;color:#00c853;font-family:monospace"><b>${p.spd.toFixed(0)} kts</b> ${desc}</div>
      <div style="font-size:11px;color:#ffeb3b;font-family:monospace">Gusts <b>${p.gst.toFixed(0)} kts</b></div>
      <div style="font-size:11px;color:var(--text-muted);font-family:monospace">From ${degToCompass(p.dir)} (${Math.round(p.dir)}°)</div>`;
    tip.style.display = 'block';

    let ch = container.querySelector('.wind-crosshair');
    if (!ch) { ch = document.createElement('div'); ch.className = 'wind-crosshair'; container.appendChild(ch); }
    ch.style.left = x + 'px'; ch.style.display = 'block';
  }

  function hide() {
    tip.style.display = 'none';
    const ch = container.querySelector('.wind-crosshair'); if (ch) ch.style.display = 'none';
  }

  container.addEventListener('touchstart', e => { e.preventDefault(); show(e.touches[0].clientX); }, { passive: false });
  container.addEventListener('touchmove',  e => { e.preventDefault(); show(e.touches[0].clientX); }, { passive: false });
  container.addEventListener('touchend', hide);
  container.addEventListener('mousemove', e => show(e.clientX));
  container.addEventListener('mouseleave', hide);
}

// ─── Pull-to-Refresh ─────────────────────────────────────────────────────────
function initPullToRefresh() {
  const indicator = document.getElementById('pull-indicator');
  if (!indicator) return;
  const THRESHOLD = 80;
  let startY = 0, pulling = false;

  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0) { startY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && window.scrollY === 0) {
      const progress = Math.min(1, dy / THRESHOLD);
      indicator.style.display = 'flex';
      indicator.style.transform = 'translateY(' + Math.min(dy * 0.5, 60) + 'px)';
      indicator.style.opacity = String(progress);
      indicator.querySelector('.pull-arrow').style.transform = progress >= 1 ? 'rotate(180deg)' : 'rotate(0deg)';
      indicator.querySelector('.pull-text').textContent = progress >= 1 ? 'Release to refresh' : 'Pull to refresh';
    }
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    const triggered = parseFloat(indicator.style.opacity) >= 1;
    indicator.style.transform = 'translateY(0)';
    indicator.style.opacity = '0';
    setTimeout(() => { indicator.style.display = 'none'; }, 300);
    if (triggered) refreshAll();
  }, { passive: true });
}

// ─── Offline Freshness ──────────────────────────────────────────────────────
function updateOnlineStatus() {
  const el = document.getElementById('offlineIndicator');
  if (!el) return;
  if (!navigator.onLine) {
    const last = document.getElementById('lastUpdated');
    el.textContent = '📡 Offline — ' + (last ? last.textContent : 'showing cached data');
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

// ─── Spot Drag-to-Reorder ────────────────────────────────────────────────────
function initSpotDrag(list) {
  const handles = list.querySelectorAll('.drag-handle');
  handles.forEach(h => {
    h.addEventListener('touchstart', onDragStart, { passive: false });
    h.addEventListener('mousedown', onDragStart);
  });
}

let _dragState = null;

function onDragStart(e) {
  e.preventDefault();
  const idx = parseInt(e.currentTarget.dataset.idx);
  const item = e.currentTarget.closest('.added-spot-item');
  const list = item.parentElement;
  const items = [...list.querySelectorAll('.added-spot-item')];
  const rect = item.getBoundingClientRect();
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  // Create a floating clone
  const clone = item.cloneNode(true);
  clone.classList.add('drag-ghost');
  clone.style.width = rect.width + 'px';
  clone.style.top = rect.top + 'px';
  clone.style.left = rect.left + 'px';
  document.body.appendChild(clone);

  item.classList.add('drag-placeholder');

  _dragState = { idx, item, clone, list, items, startY: clientY, offsetY: 0, currentIdx: idx };

  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('touchend', onDragEnd);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!_dragState) return;
  e.preventDefault();
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const dy = clientY - _dragState.startY;
  _dragState.clone.style.transform = `translateY(${dy}px)`;

  // Determine which slot we're over
  const items = _dragState.items;
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (clientY < mid && i < _dragState.currentIdx) {
      // Move up
      items[i].parentElement.insertBefore(_dragState.item, items[i]);
      _dragState.items = [..._dragState.list.querySelectorAll('.added-spot-item')];
      _dragState.currentIdx = i;
      break;
    } else if (clientY > mid && i > _dragState.currentIdx) {
      // Move down
      const next = items[i].nextElementSibling;
      items[i].parentElement.insertBefore(_dragState.item, next);
      _dragState.items = [..._dragState.list.querySelectorAll('.added-spot-item')];
      _dragState.currentIdx = i;
      break;
    }
  }
}

function onDragEnd() {
  if (!_dragState) return;
  _dragState.clone.remove();
  _dragState.item.classList.remove('drag-placeholder');

  // Apply the new order to pendingSpots
  const from = _dragState.idx;
  const to = _dragState.currentIdx;
  if (from !== to) {
    const [moved] = pendingSpots.splice(from, 1);
    pendingSpots.splice(to, 0, moved);
    renderEditorSpots();
  }

  document.removeEventListener('touchmove', onDragMove);
  document.removeEventListener('touchend', onDragEnd);
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  _dragState = null;
}

// ─── Beach Facing Picker ────────────────────────────────────────────────────
function setBeachFacing(idx, deg) {
  if (pendingSpots[idx]) { pendingSpots[idx].beachFacing = deg; renderEditorSpots(); }
}

function facingPickerHTML(idx) {
  const dirs = [
    { d: 0, l: 'N' }, { d: 45, l: 'NE' }, { d: 90, l: 'E' }, { d: 135, l: 'SE' },
    { d: 180, l: 'S' }, { d: 225, l: 'SW' }, { d: 270, l: 'W' }, { d: 315, l: 'NW' },
  ];
  const cur = pendingSpots[idx]?.beachFacing;
  const btns = dirs.map(d =>
    `<button class="facing-btn${cur === d.d ? ' active' : ''}" onclick="setBeachFacing(${idx},${d.d})">${d.l}</button>`
  ).join('');
  return `<div class="facing-label">Beach faces toward:</div><div class="facing-picker">${btns}</div>`;
}

// ─── Tide Range Toggle ──────────────────────────────────────────────────────
let _tideRange = 'default';
function toggleTideRange() {
  _tideRange = _tideRange === 'default' ? 'extended' : 'default';
  loadTides();
}

// ─── NWS dispatcher ───────────────────────────────────────────────────────────
async function loadNWS() {
  if (!ACTIVE?.isUS) return;
  const tasks = [];
  if (ACTIVE.marineZone && ACTIVE.cwfOffice) tasks.push(loadMarineForecast());
  await Promise.allSettled(tasks);
}

// ─── 7-Day Outlook ────────────────────────────────────────────────────────────
function render7DayOutlook() {
  if (!EXTENDED_DATA.swell || !EXTENDED_DATA.wind) return;

  const swPts = EXTENDED_DATA.swell;
  const wnPts = EXTENDED_DATA.wind;
  if (swPts.length < 2 || wnPts.length < 2) { setHTML('7day-body', errorHTML('Not enough forecast data')); return; }

  const now = new Date();

  // ── Group hourly data by calendar date into 3 windows ───────────────────
  // AM = 6-11, MID = 11-15, PM = 15-20
  const dayMap = new Map();
  for (const p of swPts) {
    const key = p.t.toDateString();
    if (!dayMap.has(key)) dayMap.set(key, { date: new Date(key), swell: [[], [], []], wind: [[], [], []] });
    const h = p.t.getHours();
    const slot = h >= 6 && h < 11 ? 0 : h >= 11 && h < 15 ? 1 : h >= 15 && h < 20 ? 2 : -1;
    if (slot >= 0) dayMap.get(key).swell[slot].push(p);
  }
  for (const p of wnPts) {
    const key = p.t.toDateString();
    if (!dayMap.has(key)) continue;
    const h = p.t.getHours();
    const slot = h >= 6 && h < 11 ? 0 : h >= 11 && h < 15 ? 1 : h >= 15 && h < 20 ? 2 : -1;
    if (slot >= 0) dayMap.get(key).wind[slot].push(p);
  }

  const days = [...dayMap.values()].filter(d => d.swell.some(s => s.length));
  if (days.length && days[0].date.toDateString() === now.toDateString() && now.getHours() >= 19) days.shift();
  const show = days.slice(0, 7);
  if (!show.length) { setHTML('7day-body', errorHTML('Not enough forecast data')); return; }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function dayLabel(d) {
    if (d.date.toDateString() === now.toDateString()) return 'Today';
    const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
    if (d.date.toDateString() === tmr.toDateString()) return 'Tomorrow';
    return d.date.toLocaleDateString('en-US', { weekday: 'short' });
  }
  function dateLabel(d) {
    return d.date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  }

  // Swell range for a day (all 3 windows combined)
  function swellRange(d) {
    const all = d.swell.flat();
    if (!all.length) return null;
    let lo = Infinity, hi = -Infinity, bestPer = 0, bestDir = 0, bestHt = 0;
    for (const p of all) {
      if (p.swHt < lo) lo = p.swHt;
      if (p.swHt > hi) { hi = p.swHt; bestPer = p.per; bestDir = p.dir; bestHt = p.swHt; }
    }
    return { lo: Math.round(lo), hi: Math.round(hi), per: bestPer, dir: bestDir };
  }

  // Wind summary per slot
  function windAvg(arr) {
    if (!arr.length) return null;
    let sinSum = 0, cosSum = 0, totalSpd = 0;
    for (const p of arr) {
      totalSpd += p.spd;
      sinSum += Math.sin(p.dir * Math.PI / 180);
      cosSum += Math.cos(p.dir * Math.PI / 180);
    }
    return { spd: totalSpd / arr.length, dir: ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360 };
  }

  // Swell bar color: green = good size, yellow = ok, orange = small, red = flat
  function swellBarColor(arr) {
    if (!arr.length) return '#555';
    const max = Math.max(...arr.map(p => p.swHt));
    if (max >= 5) return '#00c853';
    if (max >= 3) return '#8bc34a';
    if (max >= 1.5) return '#ffeb3b';
    if (max >= 0.5) return '#ff9800';
    return '#f44336';
  }

  // Wind bar color: green = calm, yellow = mod, orange = fresh, red = strong
  function windBarColor(arr) {
    if (!arr.length) return '#555';
    const avg = arr.reduce((s, p) => s + p.spd, 0) / arr.length;
    if (avg < 8) return '#00c853';
    if (avg < 14) return '#ffeb3b';
    if (avg < 22) return '#ff9800';
    return '#f44336';
  }

  // Height range text like "4-6ft" or "2-3ft+"
  function rangeText(r) {
    if (!r) return '-';
    if (r.lo === r.hi) return `${r.hi}ft`;
    const plus = r.hi >= 6 ? '+' : '';
    return `${r.lo}-${r.hi}ft${plus}`;
  }

  // ── Day quality: best rating across AM/MID/PM windows ───────────────
  function dayQuality(d) {
    const facing = BEACH_FACING();
    let best = null;
    for (let si = 0; si < 3; si++) {
      const sArr = d.swell[si];
      const wArr = d.wind[si];
      if (!sArr.length || !wArr.length) continue;
      const avgHt  = sArr.reduce((a, p) => a + p.swHt, 0) / sArr.length;
      const avgPer = sArr.reduce((a, p) => a + p.per, 0) / sArr.length;
      const avgDir = sArr[0].dir;
      const wAvg = windAvg(wArr);
      const q = evaluateQuality({ ht: avgHt, per: avgPer, dir: avgDir }, wAvg.spd, wAvg.dir, facing);
      if (!best || q.score > best.score) best = q;
    }
    return best;
  }

  // ── Build columns ──────────────────────────────────────────────────────
  const cols = show.map(d => {
    const r = swellRange(d);
    const dq = dayQuality(d);
    const qColor = dq ? QUALITY_COLORS[dq.label] : '#555';

    // Wind arrows: show AM, MID, PM directions
    const windSlots = d.wind.map(windAvg);

    const windArrows = windSlots.map(w => {
      if (!w) return '<span style="color:#555">-</span>';
      return `<span style="display:inline-block;transform:rotate(${w.dir + 180}deg);font-size:12px;line-height:1;color:var(--text-secondary)">↓</span>`;
    }).join('');

    // Color bar segments (AM, MID, PM)
    const swellBars = d.swell.map(s =>
      `<div style="flex:1;height:6px;border-radius:3px;background:${swellBarColor(s)}"></div>`
    ).join('');
    const windBars = d.wind.map(w =>
      `<div style="flex:1;height:6px;border-radius:3px;background:${windBarColor(w)}"></div>`
    ).join('');

    const isActive = d.date.toDateString() === now.toDateString();
    const highlight = isActive ? 'background:rgba(30,144,255,0.08);' : '';

    return `<div style="flex:1;min-width:0;text-align:center;padding:5px 2px;${highlight}border-right:1px solid var(--border);font-family:monospace">
      <div style="font-size:9px;font-weight:bold;color:var(--text-primary);white-space:nowrap">${dayLabel(d)}</div>
      <div style="font-size:8px;color:var(--text-muted);margin-bottom:2px">${dateLabel(d)}</div>
      <div style="font-size:10px;font-weight:bold;color:${qColor};margin-bottom:2px">${dq ? dq.label : '-'}</div>
      <div style="font-size:13px;font-weight:bold;color:var(--text-primary);margin-bottom:3px;white-space:nowrap">${rangeText(r)}</div>
      <div style="display:flex;justify-content:center;gap:1px;margin-bottom:3px">${windArrows}</div>
      <div style="display:flex;gap:2px;margin-bottom:2px">${swellBars}</div>
      <div style="display:flex;gap:2px">${windBars}</div>
    </div>`;
  }).join('');

  // ── Legend for color bars ───────────────────────────────────────────────
  const legend = `<div style="display:flex;justify-content:space-between;margin-top:5px;font-size:9px;color:var(--text-muted);font-family:monospace">
    <div style="display:flex;align-items:center;gap:4px">
      <span style="width:6px;height:6px;border-radius:3px;background:#00c853;display:inline-block"></span>
      <span style="width:6px;height:6px;border-radius:3px;background:#ffeb3b;display:inline-block"></span>
      <span style="width:6px;height:6px;border-radius:3px;background:#ff9800;display:inline-block"></span>
      <span style="width:6px;height:6px;border-radius:3px;background:#f44336;display:inline-block"></span>
      <span style="margin-left:2px">Swell (top) / Wind (bottom)</span>
    </div>
  </div>`;

  setHTML('7day-body', `
    <div style="display:flex;overflow-x:auto;border:1px solid var(--border);border-radius:8px;-webkit-overflow-scrolling:touch">${cols}</div>
    ${legend}
    <div class="buoy-source" style="margin-top:8px"><a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noopener" class="src-link">Open-Meteo Marine + Weather API ↗</a></div>`);
}

// ─── 24-Hour Heatmap ─────────────────────────────────────────────────────────
function render24HourHeatmap() {
  if (!EXTENDED_DATA.swell || !EXTENDED_DATA.wind) return;

  const swPts = EXTENDED_DATA.swell;
  const wnPts = EXTENDED_DATA.wind;
  if (swPts.length < 2 || wnPts.length < 2) { setHTML('24h-body', errorHTML('Not enough data')); return; }

  const now = new Date();

  // Build hourly buckets for next 24 hours
  const hours = [];
  for (let i = 0; i < 24; i++) {
    const t = new Date(now);
    t.setMinutes(0, 0, 0);
    t.setHours(t.getHours() + i);
    hours.push({ t, swell: null, wind: null });
  }

  // Match data points to hour buckets
  for (const p of swPts) {
    const key = p.t.getFullYear() * 1e6 + (p.t.getMonth() + 1) * 1e4 + p.t.getDate() * 100 + p.t.getHours();
    for (const h of hours) {
      const hKey = h.t.getFullYear() * 1e6 + (h.t.getMonth() + 1) * 1e4 + h.t.getDate() * 100 + h.t.getHours();
      if (key === hKey) { h.swell = p; break; }
    }
  }
  for (const p of wnPts) {
    const key = p.t.getFullYear() * 1e6 + (p.t.getMonth() + 1) * 1e4 + p.t.getDate() * 100 + p.t.getHours();
    for (const h of hours) {
      const hKey = h.t.getFullYear() * 1e6 + (h.t.getMonth() + 1) * 1e4 + h.t.getDate() * 100 + h.t.getHours();
      if (key === hKey) { h.wind = p; break; }
    }
  }

  // Color helpers
  function swellColor(ht) {
    if (ht >= 5) return '#00c853';
    if (ht >= 3) return '#8bc34a';
    if (ht >= 1.5) return '#ffeb3b';
    if (ht >= 0.5) return '#ff9800';
    return '#f44336';
  }
  function windColor(spd) {
    if (spd < 8) return '#00c853';
    if (spd < 14) return '#ffeb3b';
    if (spd < 22) return '#ff9800';
    return '#f44336';
  }
  const facing = BEACH_FACING();

  const cols = hours.map((h, i) => {
    const swHt = h.swell ? h.swell.swHt : null;
    const wSpd = h.wind ? h.wind.spd : null;
    const wDir = h.wind ? h.wind.dir : null;
    const isNow = i === 0;
    const highlight = isNow ? 'background:rgba(30,144,255,0.12);' : '';

    // Quality for this hour
    const hSwell = h.swell ? { ht: h.swell.swHt, per: h.swell.per, dir: h.swell.dir } : null;
    const hq = hSwell && h.wind ? evaluateQuality(hSwell, h.wind.spd, h.wind.dir, facing) : null;
    const qColor = hq ? QUALITY_COLORS[hq.label] : '#333';

    // Swell cell
    const swBg = swHt !== null ? swellColor(swHt) : '#333';
    const swText = swHt !== null ? swHt.toFixed(1) : '-';

    // Wind cell
    const wnBg = wSpd !== null ? windColor(wSpd) : '#333';
    const wnText = wSpd !== null ? Math.round(wSpd) : '-';
    const arrow = wDir !== null
      ? `<span style="display:inline-block;transform:rotate(${wDir + 180}deg);font-size:10px;line-height:1;color:var(--text-secondary)">↓</span>`
      : '-';

    // Day separator marker
    const dayBorder = h.t.getHours() === 0 ? 'border-left:2px solid var(--accent-blue);' : '';

    return `<div style="flex:0 0 36px;text-align:center;padding:4px 0;${highlight}${dayBorder}border-right:1px solid var(--border);font-family:monospace">
      <div style="height:5px;border-radius:2px;background:${qColor};opacity:0.9;margin:0 3px 2px"></div>
      <div style="font-size:8px;color:${isNow ? 'var(--accent-teal)' : 'var(--text-muted)'};font-weight:${isNow ? '700' : '400'};margin-bottom:2px">${isNow ? 'NOW' : fmtHourShort(h.t)}</div>
      <div style="font-size:10px;font-weight:700;color:${swBg};margin-bottom:2px">${swText}</div>
      <div style="margin-bottom:1px">${arrow}</div>
      <div style="font-size:9px;font-weight:600;color:${wnBg}">${wnText}</div>
      <div style="display:flex;flex-direction:column;gap:1px;margin-top:3px;padding:0 3px">
        <div style="height:5px;border-radius:2px;background:${swBg};opacity:0.8"></div>
        <div style="height:5px;border-radius:2px;background:${wnBg};opacity:0.8"></div>
      </div>
    </div>`;
  }).join('');

  const legend = `<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9px;color:var(--text-muted);font-family:monospace">
    <div style="display:flex;align-items:center;gap:6px">
      <span>Quality (top) / Swell ft / Wind kts</span>
    </div>
    <div style="display:flex;align-items:center;gap:3px">
      <span style="width:5px;height:5px;border-radius:2px;background:#9b6dff;display:inline-block" title="EPIC"></span>
      <span style="width:5px;height:5px;border-radius:2px;background:#00c853;display:inline-block" title="GOOD"></span>
      <span style="width:5px;height:5px;border-radius:2px;background:#ffb300;display:inline-block" title="FAIR"></span>
      <span style="width:5px;height:5px;border-radius:2px;background:#ff5252;display:inline-block" title="POOR"></span>
    </div>
  </div>`;

  setHTML('24h-body', `
    <div style="display:flex;overflow-x:auto;border:1px solid var(--border);border-radius:8px;-webkit-overflow-scrolling:touch;scrollbar-width:none">${cols}</div>
    ${legend}`);
}

// ─── Live Buoy Map ───────────────────────────────────────────────────────────
const MAP_BUOYS = [
  // SoCal
  { id: '46225', name: 'Torrey Pines',    lat: 32.933, lon: -117.391 },
  { id: '46086', name: 'San Clemente',    lat: 32.491, lon: -118.034 },
  { id: '46069', name: 'S Santa Rosa Is', lat: 33.674, lon: -120.212 },
  { id: '46054', name: 'Santa Barbara W', lat: 34.274, lon: -120.453 },
  { id: '46011', name: 'Santa Maria',     lat: 34.956, lon: -120.997 },
  // Central CA
  { id: '46028', name: 'Cape San Martin', lat: 35.763, lon: -121.9 },
  { id: '46239', name: 'Pt Sur',          lat: 36.342, lon: -122.11 },
  { id: '46042', name: 'Monterey',        lat: 36.787, lon: -122.408 },
  { id: '46236', name: 'Mty Canyon',      lat: 36.759, lon: -121.95 },
  { id: '46012', name: 'Half Moon Bay',   lat: 37.356, lon: -122.881 },
  { id: '46026', name: 'San Francisco',   lat: 37.75,  lon: -122.838 },
  { id: '46237', name: 'SF Bar',          lat: 37.788, lon: -122.634 },
  { id: '46214', name: 'Pt Reyes',        lat: 37.944, lon: -123.466 },
  { id: '46013', name: 'Bodega Bay',      lat: 38.235, lon: -123.317 },
  // NorCal
  { id: '46014', name: 'Pt Arena',        lat: 38.956, lon: -123.740 },
  { id: '46022', name: 'Eel River',       lat: 40.712, lon: -124.572 },
  { id: '46027', name: 'St Georges',      lat: 41.840, lon: -124.381 },
  // Oregon
  { id: '46015', name: 'Port Orford',     lat: 42.764, lon: -124.832 },
  { id: '46050', name: 'Stonewall Bank',  lat: 44.641, lon: -124.526 },
  { id: '46029', name: 'Columbia River',  lat: 46.142, lon: -124.514 },
  // Washington
  { id: '46041', name: 'Cape Elizabeth',   lat: 47.352, lon: -124.750 },
];

// Full US West Coast coastline (lat, lon) - south to north
const COASTLINE = [
  // SoCal
  [32.53,-117.12],[32.68,-117.16],[32.85,-117.27],[33.02,-117.30],
  [33.19,-117.39],[33.35,-117.59],[33.46,-117.71],[33.62,-117.93],
  [33.72,-118.19],[33.71,-118.41],[33.76,-118.43],[33.86,-118.47],
  [34.00,-118.53],[34.03,-118.81],[34.03,-119.05],[34.28,-119.27],
  [34.40,-119.54],[34.44,-119.87],[34.46,-120.47],
  // Central Coast
  [34.57,-120.64],[34.66,-120.62],[34.91,-120.87],[35.17,-120.87],
  [35.28,-120.89],[35.37,-120.86],
  // Central CA
  [35.46,-120.95],[35.64,-121.14],[35.77,-121.32],[35.89,-121.45],
  [36.06,-121.57],[36.23,-121.80],[36.37,-121.90],[36.55,-121.93],
  [36.60,-121.89],[36.62,-121.80],[36.80,-121.79],[36.87,-121.79],
  [36.95,-122.02],[37.00,-122.05],[37.10,-122.33],[37.18,-122.39],
  [37.49,-122.45],[37.62,-122.49],[37.79,-122.51],[37.83,-122.48],
  [37.86,-122.50],[37.93,-122.58],[37.96,-122.70],[37.99,-122.97],
  [38.06,-123.00],[38.24,-123.06],[38.36,-123.07],[38.45,-123.10],
  // NorCal
  [38.55,-123.14],[38.77,-123.46],[38.95,-123.69],[39.15,-123.74],
  [39.44,-123.81],[39.73,-123.82],[40.02,-124.08],[40.23,-124.24],
  [40.44,-124.41],[40.63,-124.30],[40.77,-124.20],[40.93,-124.16],
  [41.06,-124.15],[41.36,-124.06],[41.56,-124.08],[41.74,-124.20],
  // Oregon
  [42.05,-124.28],[42.25,-124.39],[42.41,-124.42],[42.73,-124.48],
  [43.37,-124.33],[43.68,-124.21],[43.98,-124.11],[44.25,-124.11],
  [44.63,-124.06],[44.84,-124.03],[44.96,-124.01],[45.23,-123.96],
  [45.46,-123.95],[45.61,-123.94],[45.77,-123.96],[45.92,-123.97],
  [46.18,-123.93],
  // Washington
  [46.28,-124.04],[46.53,-124.06],[46.75,-124.10],[47.00,-124.17],
  [47.24,-124.35],[47.53,-124.40],[47.74,-124.53],[47.90,-124.63],
  [48.15,-124.65],[48.38,-124.73],
];

// Shared map state
let _buoyMapState = null;
let _mapWindAnim = null;

// Nearshore wind point just off Asilomar (~0.5nm offshore)
const ASILOMAR_NEARSHORE = { lat: 36.621, lon: -121.955, name: 'Asilomar' };

async function loadBuoyMap() {
  try {
    // Fetch NDBC buoys + Open-Meteo nearshore wind for Asilomar in parallel
    const [buoyResults, asilomarRes] = await Promise.all([
      Promise.allSettled(
        MAP_BUOYS.map(b =>
          fetch(`${WORKER_URL}/proxy/ndbc/${b.id}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )
      ),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${ASILOMAR_NEARSHORE.lat}&longitude=${ASILOMAR_NEARSHORE.lon}&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=kn&timezone=auto`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null),
    ]);

    const buoyData = MAP_BUOYS.map((b, i) => {
      const r = buoyResults[i].status === 'fulfilled' ? buoyResults[i].value : null;
      if (!r || !r.ok) return { ...b, offline: true };
      const wv = r.wave || {};
      const wind = r.wind || {};
      return {
        ...b,
        wvHt: wv.height_m != null ? (wv.height_m * 3.28084) : null,
        dpd: wv.period_s,
        mwd: wv.direction,
        wspd: wind.speed_ms != null ? (wind.speed_ms * 1.94384) : null,
        wdir: wind.direction,
        gust: wind.gust_ms != null ? (wind.gust_ms * 1.94384) : null,
      };
    });

    // Add Asilomar nearshore wind as a special entry
    let asilomarData = { ...ASILOMAR_NEARSHORE, nearshore: true, offline: true };
    if (asilomarRes?.current) {
      const c = asilomarRes.current;
      asilomarData = {
        ...ASILOMAR_NEARSHORE,
        nearshore: true,
        wspd: c.wind_speed_10m,
        wdir: c.wind_direction_10m,
        gust: c.wind_gusts_10m,
      };
    }

    renderBuoyMap(buoyData, asilomarData);
  } catch (e) {
    setHTML('buoy-map-body', errorHTML('Buoy map unavailable: ' + e.message));
  }
}

function renderBuoyMap(buoys, asilomarNearshore) {
  // Full West Coast coordinate system
  const FLAT = 32, FLAT2 = 49, FLON = -129, FLON2 = -115.5;
  const W = 540, H = 680, PAD = 5;

  const px = (lon) => PAD + ((lon - FLON) / (FLON2 - FLON)) * (W - PAD * 2);
  const py = (lat) => PAD + ((FLAT2 - lat) / (FLAT2 - FLAT)) * (H - PAD * 2);

  // Coastline
  const coastPath = COASTLINE.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${px(p[1]).toFixed(1)},${py(p[0]).toFixed(1)}`
  ).join(' ');

  const lastPt = COASTLINE[COASTLINE.length - 1];
  const firstPt = COASTLINE[0];
  const landPath = coastPath
    + ` L${W + 5},${py(lastPt[0]).toFixed(1)} L${W + 5},${py(firstPt[0]).toFixed(1)} Z`;

  // Active spot marker
  const spotX = px(LNG()).toFixed(1);
  const spotY = py(LAT()).toFixed(1);

  // Build buoy markers with smart label placement (show text when space allows)
  let buoyMarkers = '';
  const tappablePoints = [];
  const placedBoxes = []; // bounding boxes of labels already placed
  const CHAR_W = 2; // approx SVG units per char at font-size 3.5
  const LINE_H = 5; // SVG units per text line
  const LABEL_PAD = 2; // padding around labels

  function boxOverlaps(box) {
    for (const b of placedBoxes) {
      if (box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1) return true;
    }
    return false;
  }

  // Collect all markers with priority: active buoy first, then Asilomar, then rest
  const allMarkers = [];
  for (const b of buoys) {
    const bx = parseFloat(px(b.lon).toFixed(1));
    const by = parseFloat(py(b.lat).toFixed(1));
    const isActive = b.id === ACTIVE?.buoyId;
    const lines = [];
    if (!b.offline) {
      if (b.wvHt != null) lines.push(`${b.wvHt.toFixed(1)}ft ${b.dpd ?? ''}s ${b.mwd != null ? degToCompass(b.mwd) : ''}`);
      if (b.wspd != null) lines.push(`wind ${b.wspd.toFixed(0)}kts ${b.wdir != null ? degToCompass(b.wdir) : ''}`);
    }
    const priority = isActive ? 0 : 2;
    allMarkers.push({ bx, by, name: b.name, lines, isActive, offline: b.offline,
      dotColor: b.offline ? '#555' : b.wvHt != null ? '#00d4aa' : '#ffb300',
      type: 'buoy', b, priority });
  }

  // Asilomar nearshore
  {
    const bx = parseFloat(px(ASILOMAR_NEARSHORE.lon).toFixed(1));
    const by = parseFloat(py(ASILOMAR_NEARSHORE.lat).toFixed(1));
    const hasData = asilomarNearshore && !asilomarNearshore.offline && asilomarNearshore.wspd != null;
    const lines = [];
    if (hasData) {
      lines.push(`wind ${asilomarNearshore.wspd.toFixed(0)}kts ${asilomarNearshore.wdir != null ? degToCompass(asilomarNearshore.wdir) : ''}`);
    }
    allMarkers.push({ bx, by, name: 'Asilomar', lines, isActive: false, offline: !hasData,
      dotColor: hasData ? '#00d4aa' : '#555', type: 'nearshore', b: asilomarNearshore, priority: 1 });
  }

  // Sort by priority (active first, then nearshore, then rest)
  allMarkers.sort((a, b) => a.priority - b.priority);

  // Render dots first (always shown), then attempt labels
  for (const m of allMarkers) {
    const dotR = m.isActive ? 3 : 2;
    if (m.type === 'nearshore') {
      const s = 2.5;
      buoyMarkers += `<polygon points="${m.bx},${m.by - s} ${m.bx + s},${m.by} ${m.bx},${m.by + s} ${m.bx - s},${m.by}" fill="${m.dotColor}" stroke="#fff" stroke-width="0.6"/>`;
    } else {
      buoyMarkers += `<circle cx="${m.bx}" cy="${m.by}" r="${dotR}" fill="${m.dotColor}" stroke="${m.isActive ? '#fff' : '#0f1f3d'}" stroke-width="${m.isActive ? 0.8 : 0.4}"/>`;
    }

    // Build popup lines (always available for tap)
    const popupLines = [];
    if (!m.offline && m.type === 'buoy') {
      const b = m.b;
      if (b.wvHt != null) popupLines.push(`${b.wvHt.toFixed(1)}ft ${b.dpd ?? ''}s ${b.mwd != null ? degToCompass(b.mwd) : ''}`);
      if (b.wspd != null) popupLines.push(`Wind ${b.wspd.toFixed(0)}kts ${b.wdir != null ? degToCompass(b.wdir) : ''}`);
      if (b.gust != null && b.gust > (b.wspd || 0)) popupLines.push(`Gust ${b.gust.toFixed(0)}kts`);
    } else if (m.type === 'nearshore' && !m.offline) {
      const a = m.b;
      popupLines.push(`Wind ${a.wspd.toFixed(0)}kts ${a.wdir != null ? degToCompass(a.wdir) : ''}`);
      if (a.gust != null && a.gust > a.wspd) popupLines.push(`Gust ${a.gust.toFixed(0)}kts`);
    } else {
      popupLines.push(m.offline ? 'Offline' : 'No data');
    }
    tappablePoints.push({ cx: m.bx, cy: m.by, name: m.name, lines: popupLines, type: m.type });

    // Try to place label if there's data to show
    if (m.offline || m.lines.length === 0) continue;
    const allText = [m.name, ...m.lines];
    const maxChars = Math.max(...allText.map(t => t.length));
    const textW = maxChars * CHAR_W;
    const textH = allText.length * LINE_H;

    // Try label on the left first, then right
    const leftSide = m.bx > W / 2;
    const sides = leftSide ? ['left', 'right'] : ['right', 'left'];
    let placed = false;
    for (const side of sides) {
      const lx = side === 'left' ? m.bx - 3 - textW : m.bx + 3;
      const ly = m.by - 5;
      const box = {
        x1: lx - LABEL_PAD, y1: ly - LINE_H - LABEL_PAD,
        x2: lx + textW + LABEL_PAD, y2: ly + (m.lines.length) * LINE_H + LABEL_PAD
      };
      if (!boxOverlaps(box)) {
        placedBoxes.push(box);
        const anchor = side === 'left' ? 'end' : 'start';
        const tx = side === 'left' ? m.bx - 3 : m.bx + 3;
        buoyMarkers += `<text x="${tx}" y="${m.by - 5}" text-anchor="${anchor}" fill="#8fa4b8" font-size="3.5" font-family="monospace">${m.name}</text>`;
        m.lines.forEach((line, li) => {
          buoyMarkers += `<text x="${tx}" y="${m.by + 1 + li * LINE_H}" text-anchor="${anchor}" fill="#ccd6e0" font-size="3.5" font-family="monospace" font-weight="600">${line}</text>`;
        });
        placed = true;
        break;
      }
    }
  }

  // Latitude labels every 2 degrees
  let latLabels = '';
  for (let lat = 33; lat <= 48; lat += 2) {
    latLabels += `<text x="3" y="${py(lat).toFixed(1)}" fill="#3a5068" font-size="3.5" font-family="monospace" dominant-baseline="middle">${lat}°N</text>`;
    latLabels += `<line x1="${PAD}" y1="${py(lat).toFixed(1)}" x2="${W - PAD}" y2="${py(lat).toFixed(1)}" stroke="#1a2e45" stroke-width="0.3" stroke-dasharray="1,2"/>`;
  }

  const svg = `<svg id="buoy-map-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;width:100%;height:100%;cursor:grab;touch-action:none">
    <defs>
      <marker id="arrowSwell" markerWidth="4" markerHeight="3" refX="4" refY="1.5" orient="auto">
        <polygon points="0 0, 4 1.5, 0 3" fill="#1e90ff"/>
      </marker>
      <marker id="arrowWind" markerWidth="4" markerHeight="3" refX="4" refY="1.5" orient="auto" markerUnits="strokeWidth">
        <polygon points="0 0, 4 1.5, 0 3" fill="#00c853" class="wind-arrow-fill"/>
      </marker>
    </defs>
    <rect x="-20" y="-20" width="${W + 40}" height="${H + 40}" fill="#0d1f35"/>
    ${latLabels}
    <path d="${landPath}" fill="#152238" stroke="none"/>
    <path d="${coastPath}" fill="none" stroke="#2a4a6b" stroke-width="0.8" stroke-linejoin="round"/>
    <circle cx="${spotX}" cy="${spotY}" r="2" fill="none" stroke="#ff6b6b" stroke-width="0.8"/>
    <circle cx="${spotX}" cy="${spotY}" r="0.8" fill="#ff6b6b"/>
    ${buoyMarkers}
  </svg>`;

  const legend = `<div style="display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:6px;font-size:8px;color:var(--text-muted);font-family:monospace">`
    + `<span><span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:#00d4aa;vertical-align:middle;margin-right:3px"></span>Wave data</span>`
    + `<span><span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:#ffb300;vertical-align:middle;margin-right:3px"></span>Wind only</span>`
    + `<span><span style="display:inline-block;width:6px;height:6px;background:#00d4aa;transform:rotate(45deg);vertical-align:middle;margin-right:3px"></span>Nearshore</span>`
    + `<span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;border:1.5px solid #ff6b6b;vertical-align:middle;margin-right:3px"></span>Your spot</span>`
    + `<span style="color:#4a7a96">Tap for details</span>`
    + `</div>`;

  setHTML('buoy-map-body',
    `<div class="buoy-map-wrap">${svg}<canvas id="buoy-wind-canvas"></canvas><div id="buoy-popup" class="buoy-popup"></div></div>`
    + legend
    + `<div class="buoy-source"><a href="https://www.ndbc.noaa.gov/" target="_blank" rel="noopener" class="src-link">NDBC Buoy Network ↗</a></div>`);

  // Include Asilomar nearshore in buoy array for wind animation interpolation
  const allWindSources = asilomarNearshore && !asilomarNearshore.offline
    ? [...buoys, asilomarNearshore]
    : buoys;

  // Store state for wind animation restarts after pan
  _buoyMapState = { buoys: allWindSources, W, H, PAD, FLAT, FLAT2, FLON, FLON2, px, py };

  // Set initial viewBox centered on active spot
  const svgEl = document.getElementById('buoy-map-svg');
  const wrap = svgEl.closest('.buoy-map-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  const containerAR = wrapRect.width / (wrapRect.height || 380);

  const vbH = 160; // ~4° latitude span, similar zoom to original map
  const vbW = vbH * containerAR;
  const cx = px(LNG());
  const cy = py(LAT());
  let vx = Math.max(0, Math.min(W - vbW, cx - vbW / 2));
  let vy = Math.max(0, Math.min(H - vbH, cy - vbH / 2));

  svgEl.setAttribute('viewBox', `${vx.toFixed(1)} ${vy.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`);

  // Store tappable points for tap-to-reveal
  _buoyMapState.tappablePoints = tappablePoints;

  setupMapPan(svgEl, W, H);
  startBuoyWindAnimation();
}

// ─── Map Pan + Pinch-Zoom Interaction ────────────────────────────────────────
function setupMapPan(svgEl, mapW, mapH) {
  let dragging = false;
  let startX, startY, startVBX, startVBY, vbW, vbH;
  let lastPinchDist = null;
  let didDrag = false;
  const MIN_VBW = 60;
  const MAX_VBW = mapW;
  const TAP_THRESHOLD = 6; // pixels - less than this is a tap

  function getVB() { return svgEl.getAttribute('viewBox').split(' ').map(Number); }

  function clampVB(x, y, w, h) {
    x = Math.max(0, Math.min(mapW - w, x));
    y = Math.max(0, Math.min(mapH - h, y));
    svgEl.setAttribute('viewBox', `${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  function dismissPopup() {
    const popup = document.getElementById('buoy-popup');
    if (popup) popup.classList.remove('visible');
  }

  function showPopup(clientX, clientY) {
    if (!_buoyMapState?.tappablePoints) return;
    const rect = svgEl.getBoundingClientRect();
    const vb = getVB();
    // Convert screen coords to SVG coords
    const svgX = vb[0] + ((clientX - rect.left) / rect.width) * vb[2];
    const svgY = vb[1] + ((clientY - rect.top) / rect.height) * vb[3];

    // Find nearest tappable point (within 8 SVG units)
    let best = null, bestDist = 8;
    for (const pt of _buoyMapState.tappablePoints) {
      const d = Math.hypot(pt.cx - svgX, pt.cy - svgY);
      if (d < bestDist) { bestDist = d; best = pt; }
    }
    if (!best) { dismissPopup(); return; }

    const popup = document.getElementById('buoy-popup');
    if (!popup) return;

    const wrap = svgEl.closest('.buoy-map-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    // Convert SVG coords back to CSS position within wrap
    const pxX = ((best.cx - vb[0]) / vb[2]) * wrapRect.width;
    const pxY = ((best.cy - vb[1]) / vb[3]) * wrapRect.height;

    const typeIcon = best.type === 'nearshore' ? '◆' : '●';
    const nameColor = best.type === 'nearshore' ? '#00d4aa' : '#8fa4b8';
    popup.innerHTML = `<div style="font-weight:700;color:${nameColor};margin-bottom:3px">${typeIcon} ${best.name}</div>`
      + best.lines.map(l => `<div>${l}</div>`).join('');

    // Position: above the dot, centered horizontally
    popup.style.left = pxX + 'px';
    popup.style.top = pxY + 'px';
    popup.classList.add('visible');
  }

  // Single-finger pan via pointer events
  svgEl.addEventListener('pointerdown', e => {
    dragging = true;
    didDrag = false;
    const vb = getVB();
    [startVBX, startVBY, vbW, vbH] = vb;
    startX = e.clientX;
    startY = e.clientY;
    svgEl.setPointerCapture(e.pointerId);
    svgEl.style.cursor = 'grabbing';
    if (_mapWindAnim) { cancelAnimationFrame(_mapWindAnim.raf); _mapWindAnim = null; }
  });

  svgEl.addEventListener('pointermove', e => {
    if (!dragging) return;
    e.preventDefault();
    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (dist > TAP_THRESHOLD) didDrag = true;
    const rect = svgEl.getBoundingClientRect();
    const dx = (e.clientX - startX) * (vbW / rect.width);
    const dy = (e.clientY - startY) * (vbH / rect.height);
    clampVB(startVBX - dx, startVBY - dy, vbW, vbH);
  });

  svgEl.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    svgEl.style.cursor = 'grab';
    if (!didDrag) {
      showPopup(e.clientX, e.clientY);
    } else {
      dismissPopup();
    }
    startBuoyWindAnimation();
  });

  svgEl.addEventListener('pointercancel', () => {
    dragging = false;
    svgEl.style.cursor = 'grab';
  });

  // Pinch-to-zoom via touch events
  svgEl.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      dragging = false; // cancel pan when second finger arrives
      if (_mapWindAnim) { cancelAnimationFrame(_mapWindAnim.raf); _mapWindAnim = null; }
    }
  }, { passive: true });

  svgEl.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && lastPinchDist !== null) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const scale = lastPinchDist / dist;
      lastPinchDist = dist;

      const vb = getVB();
      const ar = vb[2] / vb[3];
      let newW = Math.max(MIN_VBW, Math.min(MAX_VBW, vb[2] * scale));
      let newH = newW / ar;

      const cx = vb[0] + vb[2] / 2;
      const cy = vb[1] + vb[3] / 2;
      clampVB(cx - newW / 2, cy - newH / 2, newW, newH);
    }
  }, { passive: false });

  svgEl.addEventListener('touchend', e => {
    if (e.touches.length < 2) {
      if (lastPinchDist !== null) {
        lastPinchDist = null;
        startBuoyWindAnimation();
      }
    }
  }, { passive: true });

  // Scroll-wheel zoom (trackpad / mouse)
  svgEl.addEventListener('wheel', e => {
    e.preventDefault();
    if (_mapWindAnim) { cancelAnimationFrame(_mapWindAnim.raf); _mapWindAnim = null; }
    const vb = getVB();
    const ar = vb[2] / vb[3];
    const scale = e.deltaY > 0 ? 1.08 : 0.92;
    let newW = Math.max(MIN_VBW, Math.min(MAX_VBW, vb[2] * scale));
    let newH = newW / ar;

    // Zoom toward cursor position
    const rect = svgEl.getBoundingClientRect();
    const mx = vb[0] + ((e.clientX - rect.left) / rect.width) * vb[2];
    const my = vb[1] + ((e.clientY - rect.top) / rect.height) * vb[3];
    const nx = mx - (mx - vb[0]) * (newW / vb[2]);
    const ny = my - (my - vb[1]) * (newH / vb[3]);
    clampVB(nx, ny, newW, newH);

    clearTimeout(svgEl._wheelTimer);
    svgEl._wheelTimer = setTimeout(() => startBuoyWindAnimation(), 200);
  }, { passive: false });
}

// ─── Wind Color Overlay + Particle Animation ─────────────────────────────────
const WIND_RAMP = [
  [0,  [10, 50, 120]],
  [3,  [0, 120, 180]],
  [6,  [0, 180, 120]],
  [10, [60, 200, 50]],
  [15, [180, 210, 40]],
  [20, [240, 170, 20]],
  [25, [240, 100, 10]],
  [30, [220, 50, 20]],
  [40, [170, 20, 20]],
];

function windColorRGB(spd) {
  if (spd <= WIND_RAMP[0][0]) return WIND_RAMP[0][1];
  for (let i = 1; i < WIND_RAMP.length; i++) {
    if (spd <= WIND_RAMP[i][0]) {
      const t = (spd - WIND_RAMP[i-1][0]) / (WIND_RAMP[i][0] - WIND_RAMP[i-1][0]);
      const a = WIND_RAMP[i-1][1], b = WIND_RAMP[i][1];
      return [Math.round(a[0]+(b[0]-a[0])*t), Math.round(a[1]+(b[1]-a[1])*t), Math.round(a[2]+(b[2]-a[2])*t)];
    }
  }
  return WIND_RAMP[WIND_RAMP.length-1][1];
}

function startBuoyWindAnimation() {
  if (_mapWindAnim) { cancelAnimationFrame(_mapWindAnim.raf); _mapWindAnim = null; }
  if (!_buoyMapState) return;

  const canvas = document.getElementById('buoy-wind-canvas');
  const svgEl = document.getElementById('buoy-map-svg');
  if (!canvas || !svgEl) return;
  const ctx = canvas.getContext('2d');

  const vb = svgEl.getAttribute('viewBox').split(' ').map(Number);
  const [vbX, vbY, vbW, vbH] = vb;
  const { buoys, W, H, PAD, FLAT, FLAT2, FLON, FLON2, px, py } = _buoyMapState;

  // Size canvas to match SVG display area
  const svgRect = svgEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cw = svgRect.width;
  const ch = svgRect.height;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  ctx.scale(dpr, dpr);

  // Coordinate mapping: canvas ↔ SVG viewBox
  const svgToCanvasX = (sx) => ((sx - vbX) / vbW) * cw;
  const svgToCanvasY = (sy) => ((sy - vbY) / vbH) * ch;

  // Build coastline in canvas coordinates
  const coastPts = COASTLINE.map(p => [svgToCanvasX(px(p[1])), svgToCanvasY(py(p[0]))]);

  // Build wind sources in canvas coordinates
  const windSources = buoys
    .filter(b => !b.offline && b.wspd != null && b.wspd > 0.5 && b.wdir != null)
    .map(b => ({
      x: svgToCanvasX(px(b.lon)),
      y: svgToCanvasY(py(b.lat)),
      dir: b.wdir,
      speed: b.wspd,
      gust: b.gust || b.wspd,
    }));

  if (windSources.length === 0) return;

  function windAt(x, y) {
    let wSin = 0, wCos = 0, wSpd = 0, wGust = 0, wTotal = 0;
    for (const s of windSources) {
      const dx = x - s.x, dy = y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 1;
      const w = 1 / (dist * dist);
      const rad = s.dir * Math.PI / 180;
      wSin += Math.sin(rad) * w;
      wCos += Math.cos(rad) * w;
      wSpd += s.speed * w;
      wGust += s.gust * w;
      wTotal += w;
    }
    return {
      dir: (Math.atan2(wSin / wTotal, wCos / wTotal) * 180 / Math.PI + 360) % 360,
      speed: wSpd / wTotal,
      gust: wGust / wTotal,
    };
  }

  function isOcean(x, y) {
    for (let i = 0; i < coastPts.length - 1; i++) {
      const [x1, y1] = coastPts[i];
      const [x2, y2] = coastPts[i + 1];
      if ((y1 <= y && y2 >= y) || (y2 <= y && y1 >= y)) {
        const t = (y - y1) / (y2 - y1 || 1);
        const cx = x1 + t * (x2 - x1);
        if (x < cx) return true;
      }
    }
    return false;
  }

  // Precompute wind color overlay - low-res for smooth gradient when scaled up
  const oScale = 5;
  const ow = Math.ceil(cw / oScale);
  const oh = Math.ceil(ch / oScale);
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = ow;
  overlayCanvas.height = oh;
  const oc = overlayCanvas.getContext('2d');
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const mx = (x + 0.5) * oScale, my = (y + 0.5) * oScale;
      if (!isOcean(mx, my)) continue;
      const w = windAt(mx, my);
      const [r, g, b] = windColorRGB(w.speed);
      oc.fillStyle = `rgb(${r},${g},${b})`;
      oc.fillRect(x, y, 1, 1);
    }
  }

  // Particle system
  const avgSpeed = windSources.reduce((s, b) => s + b.speed, 0) / windSources.length;
  const count = Math.min(Math.floor(20 + avgSpeed * 2), 80);
  const particles = [];

  function spawnParticle(randomAge) {
    let x, y, attempts = 0;
    do {
      x = Math.random() * cw;
      y = Math.random() * ch;
      attempts++;
    } while (!isOcean(x, y) && attempts < 20);
    if (attempts >= 20) { x = Math.random() * cw * 0.4; y = Math.random() * ch; }

    const w = windAt(x, y);
    const rad = ((w.dir + 180) % 360) * Math.PI / 180;
    const spd = w.speed * 0.6 + Math.random() * (w.gust - w.speed) * 0.4;
    const pxPerFrame = 0.06 + spd * 0.025;
    const maxAge = 120 + Math.random() * 160;

    return {
      x, y,
      vx: Math.sin(rad) * pxPerFrame,
      vy: -Math.cos(rad) * pxPerFrame,
      age: randomAge ? Math.random() * maxAge : 0,
      maxAge,
      len: 3 + spd * 0.3,
      speed: spd,
    };
  }

  for (let i = 0; i < count; i++) particles.push(spawnParticle(true));

  function draw() {
    ctx.clearRect(0, 0, cw, ch);

    // Draw cached wind color overlay (low-res scaled up = smooth gradient)
    ctx.globalAlpha = 0.35;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(overlayCanvas, 0, 0, cw, ch);
    ctx.globalAlpha = 1;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.age++;

      const life = p.age / p.maxAge;
      let alpha;
      if (life < 0.2) alpha = life / 0.2;
      else if (life > 0.7) alpha = 1 - (life - 0.7) / 0.3;
      else alpha = 1;
      alpha *= 0.3;

      if (p.age >= p.maxAge || p.x < -10 || p.x > cw + 10 || p.y < -10 || p.y > ch + 10 || !isOcean(p.x, p.y)) {
        particles[i] = spawnParticle(false);
        continue;
      }

      const mag = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
      const tailX = p.x - p.vx * (p.len / mag);
      const tailY = p.y - p.vy * (p.len / mag);

      const [r, g, b] = windColorRGB(p.speed);
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    _mapWindAnim.raf = requestAnimationFrame(draw);
  }

  _mapWindAnim = { raf: requestAnimationFrame(draw) };
}

// ─── Refresh all ──────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!ACTIVE) return;
  if (_mapWindAnim) { cancelAnimationFrame(_mapWindAnim.raf); _mapWindAnim = null; }

  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  setHTML('lastUpdated', 'Updating…');

  // Reset visible card bodies to loading state
  QSTATE.swell = null;
  QSTATE.windKts = null;
  QSTATE.windDir = null;
  EXTENDED_DATA.swell = null;
  EXTENDED_DATA.wind  = null;
  setHTML('7day-body',          loadingHTML());
  setHTML('24h-body',           loadingHTML());
  setHTML('buoy-body',          loadingHTML());
  setHTML('wind-body',          loadingHTML());
  const _tm = document.getElementById('tide-mini'); if (_tm) _tm.innerHTML = '';
  setHTML('buoy-map-body',      loadingHTML());
  setHTML('swell-body',         loadingHTML());
  setHTML('wind-forecast-body', loadingHTML());
  setHTML('sun-moon-body',      loadingHTML());
  setHTML('uv-body',            loadingHTML());
  if (ACTIVE.isUS && ACTIVE.tideStation) setHTML('tides-body',  loadingHTML());
  if (ACTIVE.isUS && ACTIVE.marineZone)  setHTML('marine-body', loadingHTML());

  await Promise.allSettled([
    loadBuoy(),
    loadBuoyMap(),
    loadSwell(),
    loadWeather(),
    loadSunrise(),
    loadUV(),
    ACTIVE.isUS && ACTIVE.tideStation ? loadTides() : Promise.resolve(),
    ACTIVE.isUS ? loadNWS() : Promise.resolve(),
  ]);

  btn.classList.remove('spinning');
  setHTML('lastUpdated', `Updated ${fmtTime(new Date())}`);
  updateOnlineStatus();
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

// Pull-to-refresh + offline detection
initPullToRefresh();
window.addEventListener('online',  () => { updateOnlineStatus(); refreshAll(); });
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();
