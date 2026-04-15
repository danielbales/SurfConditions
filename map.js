// ─── Windy-style Map View ─────────────────────────────────────────────────────
// Animated particle map with wave markers + 24h time scrubber

// Fixed grid covering Monterey Bay (4 rows × 3 cols = 12 pts)
const GRID_LATS = [37.20, 36.85, 36.50, 36.15]; // north → south
const GRID_LNGS = [-122.30, -121.95, -121.60];  // west → east
const MAP_NX = 3, MAP_NY = 4;
const MAP_DX = 0.35, MAP_DY = 0.35;

// 9 forecast steps: now + 0h, +3h, +6h … +24h
const MAP_STEP_OFFSETS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

let mapL = null;
let mapVelocityLayer = null;
let mapWaveGroup = null;
let mapInitialized = false;
let mapWindFrames  = [];  // [{uArr, vArr}] × 9 steps
let mapSwellFrames = [];  // [{uArr, vArr}] × 9 steps
let mapSpotWaveData = []; // [{spot, hourly}] — Open-Meteo marine hourly
let mapActiveLayer = 'wind'; // 'wind' | 'swell'
let mapActiveStep  = 0;
let mapBaseHourUTC = 0;   // UTC hour index for "now" in Open-Meteo arrays

// ── Open / Close ──────────────────────────────────────────────────────────────
async function openMapView() {
  document.getElementById('map-view').style.display = 'block';
  document.body.style.overflow = 'hidden';

  if (!mapInitialized) {
    mapInitialized = true;
    await loadMapLibraries();
    initLeafletMap();
    fetchMapData();           // non-blocking — shows loading indicator
  } else if (mapL) {
    // Re-show: Leaflet needs a size recalc after the container was hidden
    setTimeout(() => mapL.invalidateSize(), 60);
  }
}

function closeMapView() {
  document.getElementById('map-view').style.display = 'none';
  document.getElementById('map-spot-panel').style.display = 'none';
  document.body.style.overflow = '';
}

// ── Library Loader ────────────────────────────────────────────────────────────
async function loadMapLibraries() {
  // Leaflet CSS
  if (!document.getElementById('leaflet-css')) {
    const lnk = document.createElement('link');
    lnk.id = 'leaflet-css'; lnk.rel = 'stylesheet';
    lnk.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(lnk);
  }
  // leaflet-velocity CSS
  if (!document.getElementById('lv-css')) {
    const lnk = document.createElement('link');
    lnk.id = 'lv-css'; lnk.rel = 'stylesheet';
    lnk.href = 'https://unpkg.com/leaflet-velocity@2.1.0/dist/leaflet-velocity.css';
    document.head.appendChild(lnk);
  }
  await mapLoadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
  await mapLoadScript('https://unpkg.com/leaflet-velocity@2.1.0/dist/leaflet-velocity.js');
}

function mapLoadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── Map Init ──────────────────────────────────────────────────────────────────
function initLeafletMap() {
  const lats = SAVED_SPOTS.map(s => s.lat);
  const lngs = SAVED_SPOTS.map(s => s.lng);
  const cx = lats.length ? lats.reduce((a, b) => a + b) / lats.length : 36.55;
  const cy = lngs.length ? lngs.reduce((a, b) => a + b) / lngs.length : -121.93;

  mapL = L.map('leaflet-map', {
    center: [cx, cy],
    zoom: 10,
    zoomControl: false,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(mapL);

  // Minimal attribution
  L.control.attribution({ position: 'bottomleft', prefix: false })
    .addAttribution('© <a href="https://carto.com">CartoDB</a>')
    .addTo(mapL);

  mapWaveGroup = L.layerGroup().addTo(mapL);
}

// ── Data Fetch ────────────────────────────────────────────────────────────────
async function fetchMapData() {
  showMapLoading(true);

  // Base hour = current UTC hour (Open-Meteo hourly[0] = midnight UTC today)
  mapBaseHourUTC = new Date().getUTCHours();

  try {
    // Wind grid: 12 pts × forecast_days=2
    const windReqs = [];
    for (const lat of GRID_LATS) {
      for (const lng of GRID_LNGS) {
        windReqs.push(
          fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
            `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC&forecast_days=2`
          ).then(r => r.json()).catch(() => null)
        );
      }
    }

    // Swell grid: 12 pts
    const swellGridReqs = [];
    for (const lat of GRID_LATS) {
      for (const lng of GRID_LNGS) {
        swellGridReqs.push(
          fetch(
            `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}` +
            `&hourly=wave_height,wave_direction&timezone=UTC&forecast_days=2`
          ).then(r => r.json()).catch(() => null)
        );
      }
    }

    // Spot wave data for markers
    const spotReqs = SAVED_SPOTS.map(sp =>
      fetch(
        `https://marine-api.open-meteo.com/v1/marine?latitude=${sp.lat}&longitude=${sp.lng}` +
        `&hourly=wave_height,wave_direction,wave_period&timezone=UTC&forecast_days=2`
      ).then(r => r.json()).catch(() => null)
    );

    const [windGrid, swellGrid, ...spotData] = await Promise.all([
      Promise.all(windReqs),
      Promise.all(swellGridReqs),
      ...spotReqs,
    ]);

    // Pre-compute frames for all 9 time steps
    mapWindFrames  = MAP_STEP_OFFSETS.map(off => buildGridFrame(windGrid,  off, 'wind'));
    mapSwellFrames = MAP_STEP_OFFSETS.map(off => buildGridFrame(swellGrid, off, 'swell'));

    mapSpotWaveData = SAVED_SPOTS.map((sp, i) => ({ spot: sp, hourly: spotData[i]?.hourly }));

    // Wire up slider
    const slider = document.getElementById('map-time-slider');
    slider.max = MAP_STEP_OFFSETS.length - 1;
    slider.value = 0;

    updateMapForStep(0);
  } catch (e) {
    console.error('Map fetch error:', e);
  } finally {
    showMapLoading(false);
  }
}

// ── Frame Builder ─────────────────────────────────────────────────────────────
function buildGridFrame(gridData, hourOffset, type) {
  // gridData: 12-element array, row-major: [GRID_LATS × GRID_LNGS]
  const hourIdx = mapBaseHourUTC + hourOffset;
  const uArr = [], vArr = [];

  for (let i = 0; i < gridData.length; i++) {
    const h = gridData[i]?.hourly;
    let speed = 0, dir = 0;

    if (type === 'wind') {
      speed = h?.wind_speed_10m?.[hourIdx]  ?? 0;
      dir   = h?.wind_direction_10m?.[hourIdx] ?? 0;
    } else {
      // swell: scale wave height so particles are visible
      speed = (h?.wave_height?.[hourIdx] ?? 0) * 0.8;
      dir   = h?.wave_direction?.[hourIdx] ?? 270;
    }

    const rad = (dir * Math.PI) / 180;
    // Met convention: direction FROM → negate for motion vector
    uArr.push(-speed * Math.sin(rad));
    vArr.push(-speed * Math.cos(rad));
  }

  return { uArr, vArr };
}

function makeVelocityData(frame) {
  const makeLayer = (data, num) => ({
    header: {
      parameterUnit: 'm.s-1',
      parameterNumber: num,
      parameterNumberName: num === 2 ? 'eastward_wind' : 'northward_wind',
      la1: GRID_LATS[0],
      la2: GRID_LATS[MAP_NY - 1],
      lo1: GRID_LNGS[0],
      lo2: GRID_LNGS[MAP_NX - 1],
      nx: MAP_NX,
      ny: MAP_NY,
      dx: MAP_DX,
      dy: MAP_DY,
      refTime: new Date().toISOString(),
      forecastTime: 0,
    },
    data,
  });
  return [makeLayer(frame.uArr, 2), makeLayer(frame.vArr, 3)];
}

// ── Map Update ────────────────────────────────────────────────────────────────
function updateMapForStep(stepIdx) {
  mapActiveStep = stepIdx;
  const offset  = MAP_STEP_OFFSETS[stepIdx];
  const hourIdx = mapBaseHourUTC + offset;

  // Time label
  const now = new Date();
  const forecastMs  = now.getTime() + offset * 3600000;
  const forecastDt  = new Date(forecastMs);
  const label = offset === 0
    ? 'Now'
    : forecastDt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  document.getElementById('map-time-label').textContent = label;

  // Remove old velocity layer
  if (mapVelocityLayer) { mapL.removeLayer(mapVelocityLayer); mapVelocityLayer = null; }

  const frame = mapActiveLayer === 'wind' ? mapWindFrames[stepIdx] : mapSwellFrames[stepIdx];

  if (frame && typeof L.velocityLayer === 'function') {
    const isWind = mapActiveLayer === 'wind';
    mapVelocityLayer = L.velocityLayer({
      displayValues: false,
      data: makeVelocityData(frame),
      maxVelocity: isWind ? 20 : 5,
      minVelocity: 0,
      velocityScale: isWind ? 0.007 : 0.014,
      opacity: 0.88,
      colorScale: isWind
        ? ['#29b6f6','#00e5ff','#69f0ae','#ffd600','#ff9800','#f44336']
        : ['#1565c0','#1976d2','#42a5f5','#80d8ff','#b3e5fc','#e1f5fe'],
      particleAge: 70,
      particleMultiplier: 0.0028,
      frameRate: 20,
    });
    mapVelocityLayer.addTo(mapL);
  }

  // Update wave markers
  mapWaveGroup.clearLayers();
  mapSpotWaveData.forEach(({ spot, hourly }) => {
    const height  = hourly?.wave_height?.[hourIdx]   ?? null;
    const dir     = hourly?.wave_direction?.[hourIdx] ?? null;
    const period  = hourly?.wave_period?.[hourIdx]   ?? null;
    if (height === null) return;

    const ft = height * 3.281;
    const color = ft >= 8 ? '#ff1744'
                : ft >= 5 ? '#ff9800'
                : ft >= 3 ? '#00e5ff'
                : ft >= 1.5 ? '#69f0ae'
                : '#4a7a96';

    // Glow halo
    L.circleMarker([spot.lat, spot.lng], {
      radius: Math.max(22, ft * 6),
      fillColor: color,
      fillOpacity: 0.10,
      color: color,
      weight: 1.5,
      opacity: 0.32,
      interactive: false,
    }).addTo(mapWaveGroup);

    // Travel direction = "from" dir + 180
    const travelDir = dir !== null ? (dir + 180) % 360 : null;
    const arrowHtml = travelDir !== null
      ? `<div class="wm-arrow" style="transform:rotate(${travelDir}deg)">↑</div>`
      : '';

    const icon = L.divIcon({
      className: 'wm-wrap',
      html: `<div class="wm-pill" style="border-color:${color};color:${color}">
               <span class="wm-ft">${ft.toFixed(1)}<small>ft</small></span>
               <span class="wm-name">${escapeHtml(spot.name.split(' ')[0])}</span>
               ${arrowHtml}
             </div>`,
      iconSize:   [74, 60],
      iconAnchor: [37, 30],
    });

    L.marker([spot.lat, spot.lng], { icon, riseOnHover: true })
      .on('click', () => showMapSpotPanel(spot, ft, period, dir, travelDir, label))
      .addTo(mapWaveGroup);
  });
}

// ── Spot Info Panel ───────────────────────────────────────────────────────────
function showMapSpotPanel(spot, ft, period, dir, travelDir, timeLabel) {
  const ftStr  = ft.toFixed(1);
  const perStr = period ? period.toFixed(0) + 's' : '—';
  const dirStr = dir !== null ? mapCompassDir(dir) : '—';
  const color  = +ftStr >= 8 ? '#ff1744'
               : +ftStr >= 5 ? '#ff9800'
               : +ftStr >= 3 ? '#00e5ff' : '#69f0ae';
  const arrowHtml = travelDir !== null
    ? `<span style="display:inline-block;transform:rotate(${travelDir}deg);font-size:18px">↑</span>`
    : '';

  document.getElementById('map-spot-panel').innerHTML = `
    <div class="msp-hdr">
      <span class="msp-name">${escapeHtml(spot.name)}</span>
      <span class="msp-time">${timeLabel}</span>
      <button class="msp-close" onclick="document.getElementById('map-spot-panel').style.display='none'">✕</button>
    </div>
    <div class="msp-stats">
      <div class="msp-stat"><span class="msp-val" style="color:${color}">${ftStr}</span><span class="msp-lbl">ft</span></div>
      <div class="msp-stat"><span class="msp-val">${perStr}</span><span class="msp-lbl">period</span></div>
      <div class="msp-stat"><span class="msp-val" style="color:${color}">${dirStr} ${arrowHtml}</span><span class="msp-lbl">swell</span></div>
    </div>
  `;
  document.getElementById('map-spot-panel').style.display = 'block';
}

// ── Layer Toggle ──────────────────────────────────────────────────────────────
function switchMapLayer(type) {
  mapActiveLayer = type;
  document.getElementById('map-btn-wind').classList.toggle('active',  type === 'wind');
  document.getElementById('map-btn-swell').classList.toggle('active', type === 'swell');
  if (mapWindFrames.length) updateMapForStep(mapActiveStep);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showMapLoading(show) {
  const el = document.getElementById('map-loading');
  if (el) el.style.display = show ? 'block' : 'none';
}

function mapCompassDir(deg) {
  const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return d[Math.round(deg / 22.5) % 16];
}
