// ─── Windy-style Wave Map ─────────────────────────────────────────────────────
// Map is always on. Particle animation for wind/swell overlays.

// Grid: 4 rows × 3 cols over Monterey Bay (north→south, west→east)
const GRID_LATS = [37.20, 36.85, 36.50, 36.15];
const GRID_LNGS = [-122.30, -121.95, -121.60];
const MAP_NX = 3, MAP_NY = 4;

// 9 forecast steps: now, +3h … +24h
const MAP_OFFSETS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

let mapL = null;
let mapParticles = null;
let mapWaveGroup = null;
let mapInitialized = false;
let mapWindFrames  = [];
let mapSwellFrames = [];
let mapSpotData    = [];
let mapActiveLayer = 'wind';
let mapActiveStep  = 0;
let mapBaseHour    = 0;

// Play/pause state
let playTimer = null;
let isPlaying = false;

// ─── Auto-init on load ────────────────────────────────────────────────────────
// Called after spots are loaded (from app.js init code)
function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;
  initLeafletMap();
  fetchMapData();
}

// ─── Map Init ─────────────────────────────────────────────────────────────────
function initLeafletMap() {
  const lats = (SAVED_SPOTS || []).map(s => s.lat);
  const lngs = (SAVED_SPOTS || []).map(s => s.lng);
  const cx = lats.length ? lats.reduce((a,b)=>a+b)/lats.length : 36.55;
  const cy = lngs.length ? lngs.reduce((a,b)=>a+b)/lngs.length : -121.93;

  mapL = L.map('map', {
    center: [cx, cy],
    zoom: 10,
    zoomControl: false,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(mapL);

  L.control.attribution({ position: 'bottomright', prefix: false })
    .addAttribution('© <a href="https://carto.com">CartoDB</a> · © <a href="https://www.openstreetmap.org">OSM</a>')
    .addTo(mapL);

  mapWaveGroup = L.layerGroup().addTo(mapL);
  mapParticles = new ParticleLayer(mapL);
}

// ─── Play / Pause ─────────────────────────────────────────────────────────────
function togglePlay() {
  const btn = document.getElementById('playBtn');
  if (isPlaying) {
    clearInterval(playTimer);
    isPlaying = false;
    btn.textContent = '▶';
    btn.classList.remove('playing');
  } else {
    isPlaying = true;
    btn.textContent = '⏸';
    btn.classList.add('playing');
    const slider = document.getElementById('map-time-slider');
    playTimer = setInterval(() => {
      const next = (+slider.value + 1) % (MAP_OFFSETS.length);
      slider.value = next;
      updateMapForStep(next);
    }, 900);
  }
}

// ─── Canvas Particle Layer ────────────────────────────────────────────────────
class ParticleLayer {
  constructor(map) {
    this.map = map;
    this.uGrid = null;
    this.vGrid = null;
    this.isWind = true;
    this.particles = [];
    this.running = false;
    this.raf = null;
    this.N = 900;
    this.maxAge = 65;

    const size = map.getSize();
    this.canvas = document.createElement('canvas');
    this.canvas.width  = size.x;
    this.canvas.height = size.y;
    this.canvas.style.cssText = 'position:absolute;inset:0;z-index:350;pointer-events:none';
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    map.on('movestart',  () => this.pause());
    map.on('moveend',    () => { this.resize(); if (this.uGrid) this.start(); });
    map.on('zoomstart',  () => this.pause());
    map.on('zoomend',    () => { this.resize(); if (this.uGrid) this.start(); });
  }

  resize() {
    const s = this.map.getSize();
    this.canvas.width  = s.x;
    this.canvas.height = s.y;
    this.spawnAll();
  }

  setFrame(uArr, vArr, isWind) {
    this.uGrid = uArr;
    this.vGrid = vArr;
    this.isWind = isWind;
    this.spawnAll();
    this.start();
  }

  uv(lat, lng) {
    const lats = GRID_LATS, lngs = GRID_LNGS;
    const ny = MAP_NY, nx = MAP_NX;
    const la = Math.max(lats[ny-1], Math.min(lats[0],    lat));
    const lo = Math.max(lngs[0],    Math.min(lngs[nx-1], lng));
    let ri = 0;
    for (let i = 0; i < ny-1; i++) { if (la <= lats[i] && la >= lats[i+1]) { ri=i; break; } }
    let ci = 0;
    for (let j = 0; j < nx-1; j++) { if (lo >= lngs[j] && lo <= lngs[j+1]) { ci=j; break; } }
    const dy = (lats[ri] - la)  / (lats[ri] - lats[ri+1]);
    const dx = (lo - lngs[ci])  / (lngs[ci+1] - lngs[ci]);
    const idx = (r,c) => r*nx+c;
    const bl  = (arr) =>
      arr[idx(ri,  ci  )]*(1-dx)*(1-dy) +
      arr[idx(ri,  ci+1)]*   dx *(1-dy) +
      arr[idx(ri+1,ci  )]*(1-dx)*   dy  +
      arr[idx(ri+1,ci+1)]*   dx *   dy;
    return { u: bl(this.uGrid), v: bl(this.vGrid) };
  }

  spawnAll() {
    const b = this.map.getBounds();
    this.particles = Array.from({ length: this.N }, () => this._rp(b));
  }

  _rp(b) {
    b = b || this.map.getBounds();
    return {
      lat: b.getSouth() + Math.random() * (b.getNorth()-b.getSouth()),
      lng: b.getWest()  + Math.random() * (b.getEast() -b.getWest()),
      age: Math.floor(Math.random() * this.maxAge),
    };
  }

  color(speed) {
    const stops = this.isWind
      ? [[0,'#29b6f6'],[4,'#00e5ff'],[8,'#69f0ae'],[13,'#ffd600'],[18,'#ff9800'],[24,'#f44336']]
      : [[0,'#1565c0'],[1,'#1976d2'],[2,'#42a5f5'],[3.5,'#80d8ff'],[5,'#b3e5fc'],[6,'#e1f5fe']];
    for (let i = stops.length-1; i >= 0; i--) {
      if (speed >= stops[i][0]) return stops[i][1];
    }
    return stops[0][1];
  }

  tick() {
    if (!this.running || !this.uGrid) return;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    const b = this.map.getBounds();
    const scale = this.isWind ? 0.0045 : 0.008;

    ctx.fillStyle = 'rgba(6,14,29,0.18)';
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1.3;

    for (const p of this.particles) {
      const {u, v} = this.uv(p.lat, p.lng);
      const speed  = Math.sqrt(u*u + v*v);
      if (speed < 0.15) { Object.assign(p, this._rp(b)); continue; }

      const p0 = this.map.latLngToContainerPoint([p.lat, p.lng]);
      p.lng += u * scale;
      p.lat += v * scale;
      p.age++;
      const p1 = this.map.latLngToContainerPoint([p.lat, p.lng]);

      ctx.globalAlpha = Math.min(1, p.age/12) * Math.max(0, 1-p.age/this.maxAge) * 0.85;
      ctx.strokeStyle = this.color(speed);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();

      if (p.age > this.maxAge
          || p.lat < b.getSouth() || p.lat > b.getNorth()
          || p.lng < b.getWest()  || p.lng > b.getEast()) {
        Object.assign(p, this._rp(b));
      }
    }

    ctx.globalAlpha = 1;
    this.raf = requestAnimationFrame(() => this.tick());
  }

  start()  { this.running = true;  this.raf = requestAnimationFrame(() => this.tick()); }
  pause()  { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); }
  clear()  { this.pause(); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
}

// ─── Data Fetch ───────────────────────────────────────────────────────────────
async function fetchMapData() {
  showMapLoading(true);
  mapBaseHour = new Date().getUTCHours();

  const tFetch = (url) =>
    Promise.race([
      fetch(url).then(r => r.ok ? r.json() : null).catch(() => null),
      new Promise(res => setTimeout(() => res(null), 10000)),
    ]);

  try {
    const windReqs = [];
    for (const lat of GRID_LATS) for (const lng of GRID_LNGS) {
      windReqs.push(tFetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC&forecast_days=2`
      ));
    }

    const spotReqs = (SAVED_SPOTS || []).map(sp => tFetch(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${sp.lat}&longitude=${sp.lng}` +
      `&hourly=wave_height,wave_direction,wave_period&timezone=UTC&forecast_days=2`
    ));

    const windGrid   = await Promise.all(windReqs);
    const spotMarine = await Promise.all(spotReqs);

    mapSpotData = (SAVED_SPOTS || []).map((sp, i) => ({ spot: sp, hourly: spotMarine[i]?.hourly }));

    mapWindFrames  = MAP_OFFSETS.map(off => buildGridFrame(windGrid, off));
    mapSwellFrames = MAP_OFFSETS.map(off => buildSwellFromSpots(off));

    const slider = document.getElementById('map-time-slider');
    slider.max   = MAP_OFFSETS.length - 1;
    slider.value = 0;

    updateMapForStep(0);
  } catch(e) {
    console.error('Map data error:', e);
  } finally {
    showMapLoading(false);
  }
}

// ─── Frame Builders ───────────────────────────────────────────────────────────
function buildGridFrame(gridData, hourOffset) {
  const h = mapBaseHour + hourOffset;
  const uArr = [], vArr = [];
  for (let i = 0; i < gridData.length; i++) {
    const hr  = gridData[i]?.hourly;
    const spd = hr?.wind_speed_10m?.[h]    ?? 0;
    const dir = hr?.wind_direction_10m?.[h] ?? 0;
    const rad = dir * Math.PI / 180;
    uArr.push(-spd * Math.sin(rad));
    vArr.push(-spd * Math.cos(rad));
  }
  return { uArr, vArr };
}

function buildSwellFromSpots(hourOffset) {
  const h = mapBaseHour + hourOffset;
  const uArr = [], vArr = [];
  for (const lat of GRID_LATS) {
    for (const lng of GRID_LNGS) {
      let best = null, bestD = Infinity;
      for (const { spot, hourly } of mapSpotData) {
        const d = Math.hypot(spot.lat-lat, spot.lng-lng);
        if (d < bestD) { bestD=d; best=hourly; }
      }
      const height = best?.wave_height?.[h]   ?? 0;
      const dir    = best?.wave_direction?.[h] ?? 270;
      const speed  = height * 0.9;
      const rad    = dir * Math.PI / 180;
      uArr.push(-speed * Math.sin(rad));
      vArr.push(-speed * Math.cos(rad));
    }
  }
  return { uArr, vArr };
}

// ─── Map Update ───────────────────────────────────────────────────────────────
function updateMapForStep(stepIdx) {
  mapActiveStep = stepIdx;
  const offset = MAP_OFFSETS[stepIdx];
  const h      = mapBaseHour + offset;

  const dt = new Date(Date.now() + offset * 3600000);
  document.getElementById('map-time-label').textContent =
    offset === 0 ? 'Now' : dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

  if (mapActiveLayer !== 'none') {
    const frames = mapActiveLayer === 'wind' ? mapWindFrames : mapSwellFrames;
    const frame  = frames[stepIdx];
    if (frame && mapParticles) {
      mapParticles.clear();
      mapParticles.setFrame(frame.uArr, frame.vArr, mapActiveLayer === 'wind');
    }
  }

  // Wave markers
  mapWaveGroup.clearLayers();
  for (const { spot, hourly } of mapSpotData) {
    const height = hourly?.wave_height?.[h]    ?? null;
    const dir    = hourly?.wave_direction?.[h] ?? null;
    const period = hourly?.wave_period?.[h]    ?? null;
    if (height === null) continue;

    const ft = height * 3.281;
    const color = ft >= 8 ? '#ff1744' : ft >= 5 ? '#ff9800' : ft >= 3 ? '#00e5ff'
                : ft >= 1.5 ? '#69f0ae' : '#4a7a96';

    L.circleMarker([spot.lat, spot.lng], {
      radius: Math.max(22, ft * 6),
      fillColor: color, fillOpacity: 0.08,
      color: color, weight: 1.5, opacity: 0.25, interactive: false,
    }).addTo(mapWaveGroup);

    const travel = dir !== null ? (dir + 180) % 360 : null;
    const icon = L.divIcon({
      className: 'wm-wrap',
      html: `<div class="wm-pill" style="border-color:${color};color:${color}">
               <span class="wm-ft">${ft.toFixed(1)}<small>ft</small></span>
               <span class="wm-name">${escapeHtml(spot.name.split(' ')[0])}</span>
               ${travel !== null ? `<span class="wm-arrow" style="transform:rotate(${travel}deg)">↑</span>` : ''}
             </div>`,
      iconSize: [74, 62], iconAnchor: [37, 31],
    });

    L.marker([spot.lat, spot.lng], { icon, riseOnHover: true })
      .on('click', () => {
        setLocation(spot.id);
        expandSheet();
      })
      .addTo(mapWaveGroup);
  }
}

// ─── Layer Toggle ─────────────────────────────────────────────────────────────
function switchMapLayer(type) {
  mapActiveLayer = type;
  ['wind', 'swell', 'none'].forEach(t => {
    const btn = document.getElementById(`layer-btn-${t}`);
    if (btn) btn.classList.toggle('active', t === type);
  });

  if (type === 'none') {
    mapParticles && mapParticles.clear();
    return;
  }
  if (mapWindFrames.length) updateMapForStep(mapActiveStep);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showMapLoading(on) {
  const el = document.getElementById('map-loading');
  if (el) el.style.display = on ? 'block' : 'none';
}

function mapCompass(deg) {
  return ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][
    Math.round(deg/22.5) % 16];
}

// ─── Auto-start map ───────────────────────────────────────────────────────────
// Leaflet is already loaded (static script tag before map.js).
// SAVED_SPOTS is available from app.js which loads before map.js.
initMap();

// ─── Bottom Sheet Drag (touch + mouse) ────────────────────────────────────────
(function setupSheetDrag() {
  const DRAG_THRESHOLD = 40;
  let dragStartY = 0;
  let dragStartExpanded = false;

  const handle = document.getElementById('sheet-handle-wrap');
  if (!handle) return;

  handle.addEventListener('touchstart', e => {
    dragStartY = e.touches[0].clientY;
    dragStartExpanded = document.getElementById('bottom-sheet').classList.contains('expanded');
  }, { passive: true });

  handle.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - dragStartY;
    if (Math.abs(dy) < 8) {
      toggleSheet();
      return;
    }
    if (dy < -DRAG_THRESHOLD && !dragStartExpanded) expandSheet();
    else if (dy > DRAG_THRESHOLD && dragStartExpanded) collapseSheet();
  }, { passive: true });
})();
