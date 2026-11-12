/* ============================================================
   OilWatch — Frontend Application
   Handles: WebSocket (live vessels), REST polling (news/prices/incidents),
   Leaflet map with shipping lanes, chokepoints, and vessel markers.
   ============================================================ */

'use strict';

// Escape untrusted text (RSS titles, AIS names/destinations) before inserting as HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
const fmtNum = (v, d = 2) => (v == null || isNaN(v) ? '--' : Number(v).toFixed(d));
const fmtSigned = (v, d = 2) => (v == null || isNaN(v) ? '--' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
const ordinal = (n) => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

// ── Config ───────────────────────────────────────────────────────────────────
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL     = `${wsProtocol}//${location.host}/ws/vessels`;
const API        = '/api';

// Without an API server (Vercel, GitHub Pages) the dashboard reads the hourly snapshot in
// /static/data/, written by scripts/build_static.py. The first failed API call switches over.
let apiDown = false;
async function getJSON(path) {
  if (!apiDown) {
    try {
      const r = await fetch(API + path);
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) return await r.json();
    } catch (e) { /* fall through to the snapshot */ }
    apiDown = true;
  }
  const name = path.split('?')[0].replace(/^\//, '');
  const r = await fetch(`/static/data/${name}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}
const NEWS_MS    = 5  * 60 * 1000;   // refresh news every 5 min
const INC_MS     = 10 * 60 * 1000;   // refresh incidents every 10 min
const PING_MS    = 25 * 1000;        // WebSocket keep-alive ping

// ── Ship type definitions ─────────────────────────────────────────────────────
const SHIP_TYPES = {
  80: { label: 'Crude Oil Tanker',        color: '#ff6b35' },
  81: { label: 'Tanker (Haz-A)',          color: '#ff6b35' },
  82: { label: 'Tanker (Haz-B)',          color: '#ff8c42' },
  83: { label: 'Tanker (Haz-C)',          color: '#ff8c42' },
  84: { label: 'Tanker (Haz-D)',          color: '#ffc23d' },
  85: { label: 'Products Tanker',         color: '#ffd700' },
  86: { label: 'LNG Carrier',             color: '#7ecfff' },
  87: { label: 'LPG Carrier',             color: '#7ecfff' },
  88: { label: 'Chemical Tanker',         color: '#9bf5a0' },
  89: { label: 'Tanker (Other)',          color: '#ff6b35' },
};

function shipInfo(type) {
  return SHIP_TYPES[type] || { label: type ? `Type ${type}` : 'Unknown Tanker', color: '#888888' };
}

// ── State ────────────────────────────────────────────────────────────────────
let map;
let mapReady = false;
let ws;
let sidebarOpen = true;
const vesselDataStore = new Map(); // mmsi → raw vessel object
let incidentMarkers = [];
let currentVesselFilter = 'all';
let currentNewsArticles = [];
let newsMarkers = [];

// ── Geographic regions for news geocoding ───────────────────────────────────
const NEWS_GEO_REGIONS = [
  { keywords: ['red sea', 'yemen', 'houthi', 'bab el-mandeb', 'bab-el-mandeb', 'aden'], name: 'Red Sea / Bab el-Mandeb', coords: [13.2, 43.1] },
  { keywords: ['hormuz', 'persian gulf', 'iran', 'oman', 'fujairah', 'strait of hormuz'], name: 'Strait of Hormuz', coords: [26.6, 56.4] },
  { keywords: ['suez', 'egypt', 'sinai'], name: 'Suez Canal', coords: [30.6, 32.3] },
  { keywords: ['malacca', 'singapore', 'straits of malacca', 'malaysia', 'indonesia'], name: 'Strait of Malacca', coords: [1.4, 102.8] },
  { keywords: ['black sea', 'bosphorus', 'novorossiysk', 'turkey', 'istanbul', 'russia', 'ukraine'], name: 'Black Sea & Bosporus', coords: [42.5, 31.0] },
  { keywords: ['north sea', 'brent', 'forties', 'norway', 'rotterdam', 'amsterdam', 'antwerp', 'ara'], name: 'North Sea & ARA', coords: [56.0, 3.5] },
  { keywords: ['gulf of mexico', 'houston', 'louisiana', 'texas', 'cushing', 'corpus christi', 'us coast guard', 'permian'], name: 'US Gulf Coast', coords: [28.0, -94.0] },
  { keywords: ['panama', 'panama canal'], name: 'Panama Canal', coords: [9.1, -79.7] },
  { keywords: ['china', 'shanghai', 'ningbo', 'shandong', 'beijing'], name: 'China Coast', coords: [31.2, 122.5] },
  { keywords: ['india', 'gujarat', 'sikka', 'jamnagar', 'mumbai'], name: 'West Coast India', coords: [22.4, 69.8] },
  { keywords: ['nigeria', 'bonny', 'gulf of guinea', 'angola'], name: 'Gulf of Guinea', coords: [4.4, 6.5] },
  { keywords: ['libya', 'es sider', 'ras lanuf', 'mediterranean'], name: 'Central Mediterranean', coords: [34.0, 18.0] },
  { keywords: ['baltic', 'primorsk', 'ust-luga'], name: 'Baltic Sea', coords: [59.5, 26.0] },
  { keywords: ['venezuela', 'pdvsa', 'caribbean', 'curacao'], name: 'Caribbean / Venezuela', coords: [12.0, -68.5] },
  { keywords: ['cape of good hope', 'south africa', 'cape town'], name: 'Cape of Good Hope', coords: [-34.5, 18.5] }
];

// ── Markers (HTML elements on the globe) ──────────────────────────────────────
// Ports, chokepoints, alerts and news pins are few, so they are HTML markers.
// Tankers can number in the thousands, so they are a GPU symbol layer instead (see initVesselLayer).
function makeMarker(lat, lon, html, { anchor = 'center', z = 0, title = '', popup = null, maxWidth = 310 } = {}) {
  const el = document.createElement('div');
  el.className = 'map-marker';
  el.style.zIndex = z;
  el.innerHTML = html;
  if (title) el.title = title;
  const m = new maplibregl.Marker({ element: el, anchor }).setLngLat([lon, lat]);
  if (popup) m.setPopup(new maplibregl.Popup({ maxWidth: `${maxWidth}px`, className: 'dark-popup', offset: 14 }).setHTML(popup));
  return m;
}

function chokepointHtml(risk) {
  const clr = risk === 'high' ? '#f87171' : risk === 'medium' ? '#fbbf24' : '#34d399';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <polygon points="13,2 24,23 2,23" fill="${clr}" fill-opacity=".25" stroke="${clr}" stroke-width="2"/>
    <rect x="12" y="9" width="2" height="7" fill="${clr}"/>
    <circle cx="13" cy="19" r="1.5" fill="${clr}"/>
  </svg>`;
}

function incidentHtml(severity) {
  const clr = severity === 'warning' ? '#f87171' : '#fbbf24';
  return `<div style="width:11px;height:11px;background:${clr};border:2px solid #fff;border-radius:50%;box-shadow:0 0 9px ${clr}"></div>`;
}

function portHtml() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" fill="#3b82f6" fill-opacity="0.3" stroke="#60a5fa" stroke-width="2"/>
    <path d="M12 6v12M8 10l4-4 4 4M7 16h10" stroke="#93c5fd" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

// ── Map init: a globe that flattens as you zoom in ────────────────────────────
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    center: [55, 20],
    zoom: 1.7,
    attributionControl: { compact: true },
    style: {
      version: 8,
      // Globe (vertical perspective) up to zoom 3, flat Mercator from zoom 6.
      projection: { type: ['interpolate', ['linear'], ['zoom'], 3, 'vertical-perspective', 6, 'mercator'] },
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 1, 7, 0] },
      sources: {
        base: { type: 'raster', tiles: [`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 16,
                attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ' },
        labels: { type: 'raster', tiles: [`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 16 },
      },
      layers: [
        { id: 'space', type: 'background', paint: { 'background-color': '#0c0c0e' } },
        { id: 'base', type: 'raster', source: 'base' },
        { id: 'labels', type: 'raster', source: 'labels' },
      ],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');

  map.on('load', () => {
    mapReady = true;
    loadShippingLanes();
    initVesselLayer();
    loadChokepoints();
    loadMajorPorts();
    plotNews();
    loadIncidentsMarkers();
  });
}

function sanitizeSentences(text, maxSentences = 3) {
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!sentences || sentences.length === 0) {
    return text.slice(0, 200);
  }
  return sentences.slice(0, maxSentences).join('').trim();
}

const MAJOR_OIL_PORTS = [
  { name: 'Ras Tanura Superterminal', country: 'Saudi Arabia', coords: [26.64, 50.16], type: 'Crude Export Superterminal', desc: 'World’s largest offshore oil loading facility operated by Saudi Aramco. Handles bulk VLCC crude exports from the Ghawar and Abqaiq fields directly into global maritime lanes. Essential gateway supplying Asian and Western refineries.' },
  { name: 'Port of Fujairah', country: 'UAE', coords: [25.18, 56.36], type: 'Bunkering & Bypass Hub', desc: 'Major global bunkering anchorage situated outside the Strait of Hormuz on the Gulf of Oman. Connected to Abu Dhabi via the Habshan pipeline, enabling crude export bypass of Hormuz. Vital hub for STS transfers, marine fuels, and Middle East product trading.' },
  { name: 'Houston Ship Channel', country: 'USA', coords: [29.73, -95.15], type: 'Refining & Petrochemical Capital', desc: 'Premier petrochemical and crude refining complex in the Western Hemisphere. Connects Texas Permian and Eagle Ford production with international waterborne product markets. Houses major processing plants handling millions of barrels of refined fuels daily.' },
  { name: 'Port of Rotterdam', country: 'Netherlands', coords: [51.95, 4.13], type: 'European Crude Inflow Gateway', desc: 'Largest seaport in Europe and primary pricing node for the ARA refining hub. Features extensive deep-water crude discharge jetties and pipeline links to German and Belgian refineries. Serves as key delivery terminal for North Sea and transatlantic imports.' },
  { name: 'Port of Corpus Christi', country: 'USA', coords: [27.81, -97.39], type: 'Leading US Crude Export Port', desc: 'Number one crude oil export gateway in the United States by volume. Deep-draft channel allows loading of Suezmax and partially laden VLCC tankers for European and Asian destinations. Primary conduit for surging Permian basin light sweet crude.' },
  { name: 'Ningbo-Zhoushan Port', country: 'China', coords: [29.89, 122.10], type: 'Mega Crude Storage & Import Terminal', desc: 'World’s busiest cargo port and key crude oil discharge center for China’s eastern refineries. Features deepwater berths capable of handling 450,000 DWT ultra-large crude carriers. Houses strategic petroleum reserve caverns and commercial bonded storage.' },
  { name: 'Singapore Jurong Island', country: 'Singapore', coords: [1.27, 103.72], type: 'Asia-Pacific Pricing & Refining Node', desc: 'Southeast Asia’s central petroleum pricing and oil products trading hub. Home to extensive integrated refineries and commercial floating and onshore storage tanks. Direct gatekeeper to Malacca maritime freight lanes.' },
  { name: 'Es Sider Terminal', country: 'Libya', coords: [30.63, 18.36], type: 'Mediterranean Crude Export Port', desc: 'Libya’s largest crude oil export terminal located in the Gulf of Sirte. Connects via pipeline network to the major Waha oil fields in the Sirte Basin. Critical supplier of light sweet crude to European Mediterranean refineries.' }
];

function loadMajorPorts() {
  MAJOR_OIL_PORTS.forEach(port => {
    makeMarker(port.coords[0], port.coords[1], portHtml(), {
      z: 2, title: port.name,
      popup: `
        <div style="min-width:250px">
          <div style="font-size:12px; color:var(--text-dim); margin-bottom:2px;">Oil port · ${port.country}</div>
          <div class="popup-title">${port.name}</div>
          <div class="popup-row"><span class="lbl">Role</span><span class="val">${port.type}</span></div>
          <p class="popup-desc">${sanitizeSentences(port.desc, 3)}</p>
        </div>`,
    }).addTo(map);
  });
}

async function loadShippingLanes() {
  try {
    const data = await (await fetch('/static/data/shipping_lanes.geojson')).json();
    if (!data.features || data.features.length === 0) return;
    map.addSource('lanes', { type: 'geojson', data });
    map.addLayer({ id: 'lanes', type: 'line', source: 'lanes', paint: { 'line-color': '#60a5fa', 'line-opacity': 0.22, 'line-width': 1 } },
                 map.getLayer('vessels') ? 'vessels' : undefined);
  } catch (e) {
    console.warn('Shipping lanes unavailable:', e.message);
  }
}

async function loadChokepoints() {
  try {
    const data = await (await fetch('/static/data/chokepoints.geojson')).json();
    data.features.forEach(f => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      makeMarker(lat, lon, chokepointHtml(p.risk_level), { anchor: 'bottom', z: 3, title: p.name, popup: buildChokepointPopup(p) }).addTo(map);
    });
  } catch (e) {
    console.warn('Chokepoints unavailable:', e.message);
  }
}

function buildChokepointPopup(p) {
  const riskClass = `risk-${p.risk_level}`;
  return `
    <div style="min-width:250px">
      <div class="popup-title">${p.name}</div>
      <div class="popup-row"><span class="lbl">Daily volume</span><span class="val">${p.volume_mbpd}M bbl/day</span></div>
      <div class="popup-row"><span class="lbl">Risk level</span><span class="val ${riskClass}">${p.risk_level}</span></div>
      <p class="popup-desc">${sanitizeSentences(p.description, 3)}</p>
    </div>`;
}

// ── Vessels: one GeoJSON source, arrows rotated by heading ────────────────────
const vesselClassOf = (v) => v.vessel_class || (v.length >= 300 ? 'VLCC' : v.length >= 240 ? 'Suezmax' : v.length >= 200 ? 'Aframax' : 'Product');
const CLASS_COLOR = { VLCC: '#fbbf24', Suezmax: '#60a5fa', Aframax: '#10b981', Product: '#a855f7' };

function initVesselLayer() {
  // White arrow drawn once; the layer tints it per class (SDF icon).
  const s = 44, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(s / 2, 2); g.lineTo(s - 8, s - 3); g.lineTo(s / 2, s - 12); g.lineTo(8, s - 3); g.closePath(); g.fill();
  map.addImage('ship', g.getImageData(0, 0, s, s), { sdf: true, pixelRatio: 2 });

  map.addSource('vessels', { type: 'geojson', data: vesselGeoJSON() });
  map.addLayer({
    id: 'vessels', type: 'symbol', source: 'vessels',
    layout: {
      'icon-image': 'ship',
      'icon-size': ['match', ['get', 'cls'], 'VLCC', 1.0, 'Suezmax', 0.88, 'Aframax', 0.78, 0.68],
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': 'rgba(0,0,0,0.7)', 'icon-halo-width': 1 },
  });
  map.on('click', 'vessels', (e) => {
    const v = vesselDataStore.get(String(e.features[0].properties.mmsi));
    if (!v) return;
    const cls = vesselClassOf(v);
    new maplibregl.Popup({ maxWidth: '300px', className: 'dark-popup', offset: 10 })
      .setLngLat([v.lon, v.lat]).setHTML(buildVesselPopup(v, cls, CLASS_COLOR[cls])).addTo(map);
  });
  map.on('mouseenter', 'vessels', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'vessels', () => { map.getCanvas().style.cursor = ''; });
  applyVesselFilter();
}

function vesselGeoJSON() {
  const features = [];
  for (const v of vesselDataStore.values()) {
    const cls = vesselClassOf(v);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      properties: { mmsi: String(v.mmsi), cls, color: CLASS_COLOR[cls], heading: v.heading ?? v.cog ?? 0 },
    });
  }
  return { type: 'FeatureCollection', features };
}

let vesselRefreshPending = false;
function upsertVessel(v) {
  if (v.lat == null || v.lon == null) return;
  const mmsi = String(v.mmsi);
  vesselDataStore.set(mmsi, { ...(vesselDataStore.get(mmsi) || {}), ...v });
  if (vesselRefreshPending) return;
  vesselRefreshPending = true;
  requestAnimationFrame(() => {
    vesselRefreshPending = false;
    if (mapReady && map.getSource('vessels')) map.getSource('vessels').setData(vesselGeoJSON());
    updateFilterCounts();
  });
}

function buildVesselPopup(v, vClass, color) {
  const name    = esc(v.name || `MMSI ${v.mmsi}`);
  const speed   = v.sog != null ? `${Number(v.sog).toFixed(1)} kn` : '—';
  const upd     = v.updated_at ? formatUtcTimestamp(new Date(v.updated_at)) : '—';
  const draught = v.draught ? `${Number(v.draught).toFixed(1)} m` : '—';
  const cargo   = v.cargo_status || 'Unknown load';
  const cargoClass = cargo.startsWith('Laden') ? 'pill-laden' : cargo.startsWith('Ballast') ? 'pill-ballast' : 'pill-storage';
  const mmsi = encodeURIComponent(v.mmsi);

  return `
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:6px;">
        <span class="tanker-class-tag" style="background:${color}22; color:${color}; border:1px solid ${color}66;">${esc(v.vessel_desc || vClass)}</span>
        <span class="cargo-pill ${cargoClass}" title="Estimated from crew-entered AIS draught">${esc(cargo)}</span>
      </div>
      <div class="popup-title">${name}</div>
      <div class="popup-row"><span class="lbl">MMSI</span><span class="val">${esc(v.mmsi)}</span></div>
      <div class="popup-row"><span class="lbl">Length · draught</span><span class="val">${esc(v.length || '—')} m · ${draught}</span></div>
      <div class="popup-row"><span class="lbl">Speed · course</span><span class="val">${speed} · ${Math.round(v.cog || 0)}° ${v.motion === 'Stationary' ? '(stationary)' : ''}</span></div>
      <div class="popup-row"><span class="lbl">Destination</span><span class="val">${esc(v.destination || '—')}</span></div>
      ${v.callsign ? `<div class="popup-row"><span class="lbl">Callsign</span><span class="val">${esc(v.callsign)}</span></div>` : ''}
      <div class="popup-row"><span class="lbl">Last AIS report</span><span class="val">${upd}</span></div>
      <a class="popup-link" href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}" target="_blank" rel="noopener">View on MarineTraffic ↗</a>
    </div>`;
}

function setVesselFilter(filterClass) {
  currentVesselFilter = filterClass;
  document.querySelectorAll('.vfilter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.class === filterClass);
  });
  applyVesselFilter();
}

function applyVesselFilter() {
  if (!mapReady || !map.getLayer('vessels')) return;
  const f = currentVesselFilter;
  map.setLayoutProperty('vessels', 'visibility', f === 'incidents' ? 'none' : 'visible');
  map.setFilter('vessels', f === 'all' || f === 'incidents' ? null : ['==', ['get', 'cls'], f]);
  if (f === 'incidents') {
    document.getElementById('vessel-count').textContent = '0';
    showIncidentsFeed();
    return;
  }
  updateFilterCounts();
}

function updateFilterCounts() {
  const n = { all: 0, VLCC: 0, Suezmax: 0, Aframax: 0, Product: 0 };
  for (const v of vesselDataStore.values()) { n.all++; n[vesselClassOf(v)]++; }
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('vf-all', n.all);
  setEl('vf-vlcc', n.VLCC);
  setEl('vf-suez', n.Suezmax);
  setEl('vf-afra', n.Aframax);
  setEl('vf-prod', n.Product);
  if (currentVesselFilter !== 'incidents') setEl('vessel-count', currentVesselFilter === 'all' ? n.all : n[currentVesselFilter]);
}

// ── Last Updated Formatter ──────────────────────────────────────────────────
function formatUtcTimestamp(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '--';
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months[dateObj.getUTCMonth()];
  const year = dateObj.getUTCFullYear();
  const hours = String(dateObj.getUTCHours()).padStart(2, '0');
  const mins = String(dateObj.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hours}:${mins} UTC`;
}

function updateLastSeenTimestamp(isoDateStr) {
  const el = document.getElementById('vessel-last-updated');
  if (!el || !isoDateStr) return;
  el.textContent = `Tankers as of ${formatUtcTimestamp(new Date(isoDateStr))}`;
}

function setStatus(state) {
  const dot = document.getElementById('update-dot') || document.querySelector('#conn-status .dot');
  if (dot) {
    dot.className = state === 'live' ? 'dot live' : 'dot connecting';
  }
}

// ── News ──────────────────────────────────────────────────────────────────────
async function loadNews() {
  try {
    const { news } = await getJSON('/news?limit=20');
    currentNewsArticles = news || [];
    const list = document.getElementById('news-list');

    if (!news || !news.length) {
      list.innerHTML = '<div class="news-empty">No news yet.</div>';
      return;
    }

    list.innerHTML = news.map(item => {
      const dateStr = item.published
        ? new Date(item.published).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
        : '';
      const sent = ['bullish', 'bearish'].includes(item.sentiment) ? item.sentiment : 'neutral';
      const sentBadge = `<span class="news-sentiment sent-${sent}" title="Keyword-based tone for oil prices, not a forecast">${sent}</span>`;
      return `
        <div class="news-card">
          <div class="news-meta">
            <span class="news-src">${esc(item.source || '—')}</span>
            ${sentBadge}
            <span class="news-date">${dateStr}</span>
          </div>
          <a class="news-title" href="${safeUrl(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a>
        </div>`;
    }).join('');
    plotNews();
  } catch (e) {
    console.warn('News unavailable:', e.message);
  }
}

// ── Incidents ─────────────────────────────────────────────────────────────────
let currentIncidents = [];

function loadIncidentsMarkers() {
  if (!mapReady) return;
  incidentMarkers.forEach(m => m.remove());
  incidentMarkers = [];
  currentIncidents.forEach(inc => {
    if (inc.lat == null || inc.lon == null) return;
    const shortDesc = sanitizeSentences(inc.description, 3);
    const sev = inc.severity === 'warning' ? 'warning' : 'advisory';
    const m = makeMarker(inc.lat, inc.lon, incidentHtml(inc.severity), {
      z: 5, title: inc.title, maxWidth: 300,
      popup: `
        <div>
          <div class="popup-title">${esc(inc.title)}</div>
          <div class="popup-row"><span class="lbl">Area</span><span class="val">${esc(inc.area || '—')} (area-level position)</span></div>
          <div class="popup-row"><span class="lbl">Type</span><span class="val risk-${sev}">${sev}</span></div>
          <div class="popup-row"><span class="lbl">Source</span><span class="val">${esc(inc.source || 'News')}</span></div>
          ${shortDesc ? `<p class="popup-desc">${esc(shortDesc)}</p>` : ''}
          ${inc.link ? `<a class="popup-link" href="${safeUrl(inc.link)}" target="_blank" rel="noopener">Read the report ↗</a>` : ''}
        </div>`,
    }).addTo(map);
    m._lat = inc.lat; m._lon = inc.lon;
    incidentMarkers.push(m);
  });
}

async function loadIncidents() {
  try {
    const { incidents } = await getJSON('/incidents');
    currentIncidents = (incidents || []).filter(i => i.lat != null && i.lon != null);
    loadIncidentsMarkers();

    const visibleCount = currentIncidents.length;
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('incident-count', visibleCount);
    setEl('sb-inc-count', visibleCount);
    setEl('vf-inc', visibleCount);

    const incList = document.getElementById('incidents-list');
    if (incList) {
      if (!currentIncidents.length) {
        incList.innerHTML = '<div class="news-empty">No security alerts in recent news.<br><small>Official advisories: <a href="https://www.ukmto.org/recent-incidents" target="_blank" rel="noopener">UKMTO</a></small></div>';
      } else {
        incList.innerHTML = '<div class="inc-note">Derived from news reports and plotted at the named sea area, not the exact position. Official advisories: <a href="https://www.ukmto.org/recent-incidents" target="_blank" rel="noopener">UKMTO</a>.</div>' +
          currentIncidents.map((inc, i) => {
          const sevClass = inc.severity === 'warning' ? 'risk-high' : 'risk-medium';
          const dateStr = inc.published_at ? new Date(inc.published_at).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
          const shortDesc = sanitizeSentences(inc.description, 2);
          return `
            <div class="inc-card" data-idx="${i}">
              <div class="inc-card-hdr">
                <span class="inc-card-area">${esc(inc.area || 'Maritime area')}</span>
                <span class="inc-card-sev ${sevClass}">${inc.severity === 'warning' ? 'Warning' : 'Advisory'}</span>
              </div>
              <div class="inc-card-title">${esc(inc.title)}</div>
              <div class="inc-card-desc">${esc(shortDesc)}</div>
              <div class="inc-card-meta">
                <span>${inc.link ? `<a href="${safeUrl(inc.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(inc.source || 'News')} ↗</a>` : esc(inc.source || 'News')}</span>
                <span>${dateStr}</span>
              </div>
            </div>`;
        }).join('');
        incList.querySelectorAll('.inc-card[data-idx]').forEach(el => {
          el.addEventListener('click', () => {
            const inc = currentIncidents[Number(el.dataset.idx)];
            if (inc) flyToIncident(inc.lat, inc.lon);
          });
        });
      }
    }
  } catch (e) {
    console.warn('Incidents unavailable:', e.message);
  }
}

function flyToIncident(lat, lon) {
  if (lat == null || lon == null || !map) return;
  map.flyTo({ center: [lon, lat], zoom: 7, duration: 1500 });
  const m = incidentMarkers.find(mk => Math.abs(mk._lat - lat) < 0.001 && Math.abs(mk._lon - lon) < 0.001);
  if (m) map.once('moveend', () => { if (!m.getPopup().isOpen()) m.togglePopup(); });
}

function showIncidentsFeed() {
  if (!sidebarOpen) toggleSidebar();
  switchSidebarTab('incidents');
  if (incidentMarkers.length > 0 && map) {
    const b = new maplibregl.LngLatBounds();
    incidentMarkers.forEach(m => b.extend(m.getLngLat()));
    map.fitBounds(b, { padding: 60, maxZoom: 6, duration: 1500 });
  }
}

function switchSidebarTab(tabName) {
  document.querySelectorAll('.sb-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sidebar-tab-content').forEach(p => p.classList.remove('active'));

  const btn = document.getElementById(`tab-sb-${tabName}`);
  const panel = document.getElementById(`${tabName}-list`);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  const sb = document.getElementById('sidebar');
  const reopenBtn = document.getElementById('sidebar-reopen-btn');
  if (sb) sb.classList.toggle('collapsed', !sidebarOpen);
  if (reopenBtn) reopenBtn.classList.toggle('visible', !sidebarOpen);
  if (map) setTimeout(() => map.resize(), 300);
}

// ── News pins: always on the map, at the region the article names ─────────────
function geocodeNews(article) {
  const text = `${article.title || ''} ${article.summary || ''}`.toLowerCase();
  for (const region of NEWS_GEO_REGIONS) {
    if (region.keywords.some(kw => text.includes(kw))) {
      // Jitter so several pins in one region don't overlap exactly
      let h = 0;
      for (const ch of (article.link || article.title || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
      return {
        lat: region.coords[0] + (((h & 0xff) / 255) - 0.5) * 1.5,
        lon: region.coords[1] + ((((h >> 8) & 0xff) / 255) - 0.5) * 2.0,
        regionName: region.name,
      };
    }
  }
  return null;
}

function newsPinHtml(sentiment) {
  const sent = (sentiment || 'neutral').toLowerCase();
  const clr = sent === 'bullish' ? '#34d399' : sent === 'bearish' ? '#f87171' : '#60a5fa';
  return `
    <div class="news-map-pin">
      <div class="news-pin-pulse" style="border-color:${clr}; background:${clr}33;"></div>
      <div class="news-pin-icon" style="background:${clr};"></div>
    </div>`;
}

function plotNews() {
  if (!mapReady) return;
  newsMarkers.forEach(m => m.remove());
  newsMarkers = [];
  (currentNewsArticles || []).forEach(art => {
    const loc = geocodeNews(art);
    if (!loc) return;
    const sent = (art.sentiment || 'neutral').toLowerCase();
    const dateStr = art.published
      ? new Date(art.published).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
      : '';
    const popupHtml = `
      <div class="news-map-popup">
        <div style="font-size:12px; color:var(--text-dim); margin-bottom:4px;">${esc(loc.regionName)} (approximate)</div>
        <div class="popup-title">${esc(art.title)}</div>
        <div style="display:flex; gap:8px; align-items:center; margin:6px 0;">
          <span style="font-size:12px; font-weight:600; color:var(--accent);">${esc(art.source || 'News')}</span>
          <span class="news-sentiment sent-${sent}">${sent}</span>
          <span style="font-size:12px; color:var(--text-dim);">${dateStr}</span>
        </div>
        ${art.link ? `<a class="popup-link" href="${safeUrl(art.link)}" target="_blank" rel="noopener" style="margin-top:8px; display:inline-block;">Read the article ↗</a>` : ''}
      </div>`;
    newsMarkers.push(makeMarker(loc.lat, loc.lon, newsPinHtml(art.sentiment), { z: 4, title: art.title, popup: popupHtml, maxWidth: 320 }).addTo(map));
  });
}

// ── Clock ─────────────────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('last-updated');
  if (!el) return;
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

// ── View Switching ─────────────────────────────────────────────────────────────
let currentView = 'map';

function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));

  if (viewName === 'map') {
    document.getElementById('tab-map-btn').classList.add('active');
    document.getElementById('view-map').classList.add('active');
    if (map) setTimeout(() => map.resize(), 150);
  } else if (viewName === 'analysis') {
    document.getElementById('tab-analysis-btn').classList.add('active');
    document.getElementById('view-analysis').classList.add('active');
    loadAnalysis();
  }
}

// ── Price Discovery & Valuation Model ─────────────────────────────────────────
let analysisLoaded = false;

async function loadAnalysis(force = false) {
  const factsEl = document.getElementById('facts-list');

  try {
    const data = await getJSON('/analysis');
    analysisLoaded = true;

    if (!data.available) {
      factsEl.innerHTML = `<li>${esc(data.error || 'Market data unavailable.')}</li>`;
      return;
    }

    const q = data.quotes || {};
    const ctx = data.context || {};
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const ctxLine = (key, fallback) => {
      const c = ctx[key];
      return c ? `${ordinal(c.percentile_5y)} pct of 5y · z ${fmtSigned(c.z_5y)}` : fallback;
    };

    setText('mkt-brent', q.brent != null ? `$${fmtNum(q.brent)}` : '--');
    setText('ctx-brent', ctxLine('brent', 'ICE Brent'));
    setText('mkt-wti', q.wti != null ? `$${fmtNum(q.wti)}` : '--');
    setText('ctx-wti', ctxLine('wti', 'NYMEX WTI, Cushing'));
    setText('mkt-spread', q.spread != null ? `${q.spread < 0 ? '−' : '+'}$${fmtNum(Math.abs(q.spread))}` : '--');
    setText('ctx-spread', ctxLine('spread', 'Seaborne vs inland crude'));
    setText('mkt-crack', q.crack_321 != null ? `$${fmtNum(q.crack_321)}` : '--');
    setText('ctx-crack_321', ctxLine('crack_321', 'US refining margin'));
    setText('mkt-natgas', q.natgas != null ? `$${fmtNum(q.natgas)}` : '--');
    setText('ctx-natgas', ctxLine('natgas', '$/MMBtu'));

    const termEl = document.getElementById('mkt-term');
    const cs = q.calendar_spread;
    const c = q.contracts || {};
    setText('mkt-term-label', `WTI ${(c.wti_m1 || 'M1').split('.')[0]} − ${(c.wti_m2 || 'M2').split('.')[0]}`);
    if (cs != null) {
      termEl.textContent = `${fmtSigned(cs)} $/bbl`;
      termEl.style.color = cs > 0.05 ? '#34d399' : cs < -0.05 ? '#f87171' : '';
      setText('mkt-term-desc', cs > 0.05 ? 'Backwardation: tight prompt supply' : cs < -0.05 ? 'Contango: ample prompt supply' : 'Flat curve');
    } else {
      termEl.textContent = '--';
    }

    factsEl.innerHTML = (data.summary || []).map(l => `<li>${esc(l)}</li>`).join('') || '<li>No data.</li>';

    // Reference levels with a Brent marker
    const levels = data.reference_levels || [];
    const maxVal = Math.max(120, ...(levels.map(l => l.value)), q.brent || 0) * 1.05;
    const brentPct = q.brent != null ? (q.brent / maxVal) * 100 : null;
    document.getElementById('ref-levels').innerHTML = levels.map(l => `
      <div class="cost-row" title="${esc(l.note)}">
        <span class="cost-name">${esc(l.name)}</span>
        <div class="cost-bar-wrapper">
          <div class="cost-bar" style="width:${(l.value / maxVal) * 100}%; background:${q.brent != null && q.brent >= l.value ? '#34d399' : '#fbbf24'}"></div>
          ${brentPct != null ? `<div class="brent-marker" style="left:${brentPct}%" title="Brent $${fmtNum(q.brent)}"></div>` : ''}
        </div>
        <span class="cost-val">~$${l.value}</span>
      </div>`).join('') + (q.brent != null ? `<div class="ref-legend"><span class="brent-marker-key"></span> Brent $${fmtNum(q.brent)}</div>` : '');

    const asof = q.brent_asof || q.wti_asof;
    setText('analysis-sub', `Front-month futures${asof ? ` as of ${asof}` : ''}, each ranked against its own last 5 years · source: Yahoo Finance`);
  } catch (e) {
    console.error('Error loading analysis:', e);
    factsEl.innerHTML = `<li style="color:var(--danger)">Failed to load market data: ${esc(e.message)}</li>`;
  }
}

// ── Synchronized 10-Year Historical Charts Engine ─────────────────────────────
let currentAnalysisMode = 'cards';
let historical10yData = null;
let chartInstances = {};
let isSyncHovering = false;
let visibleZoomWindow = { start: 0, end: 0 }; // index range in dates array

function setAnalysisMode(mode) {
  currentAnalysisMode = mode;
  const btnCards = document.getElementById('btn-mode-cards');
  const btnCharts = document.getElementById('btn-mode-charts');
  const cardsGrid = document.getElementById('market-cards-grid');
  const chartsGrid = document.getElementById('market-charts-grid');

  if (btnCards) btnCards.classList.toggle('active', mode === 'cards');
  if (btnCharts) btnCharts.classList.toggle('active', mode === 'charts');

  if (mode === 'cards') {
    if (cardsGrid) cardsGrid.style.display = 'grid';
    if (chartsGrid) chartsGrid.style.display = 'none';
  } else {
    if (cardsGrid) cardsGrid.style.display = 'none';
    if (chartsGrid) chartsGrid.style.display = 'grid';
    initOrUpdateSyncCharts();
  }
}

async function initOrUpdateSyncCharts() {
  if (!window.Chart) {
    console.warn('Chart.js library is not yet loaded.');
    return;
  }

  if (!historical10yData) {
    try {
      historical10yData = await getJSON('/historical-data');
      if (!historical10yData.available || !historical10yData.dates.length) {
        document.getElementById('market-charts-grid').innerHTML = '<div class="memo-loading">Historical data unavailable right now (Yahoo Finance did not respond).</div>';
        historical10yData = null;
        return;
      }
      visibleZoomWindow.end = historical10yData.dates.length - 1;
    } catch (e) {
      console.error('Failed to load historical 10Y data:', e);
      return;
    }
  }

  const keys = ['brent', 'wti', 'spread', 'crack', 'natgas'];
  const seriesKeysMap = { brent: 'brent', wti: 'wti', spread: 'spread', crack: 'crack_321', natgas: 'natgas' };
  const SERIES_COLORS = { brent: '#ff6b35', wti: '#60a5fa', spread: '#a855f7', crack_321: '#fbbf24', natgas: '#38bdf8' };

  keys.forEach(key => {
    const canvasId = `canvas-${key}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    if (chartInstances[key]) {
      chartInstances[key].update();
      return;
    }

    const sKey = seriesKeysMap[key];
    const s = historical10yData.series[sKey];
    if (!s) return;
    s.color = s.color || SERIES_COLORS[sKey] || '#91919b';

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, `${s.color}33`);
    gradient.addColorStop(1, `${s.color}00`);

    chartInstances[key] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: historical10yData.dates,
        datasets: [{
          label: s.name,
          data: s.data,
          borderColor: s.color,
          backgroundColor: gradient,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: s.color,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          fill: true,
          tension: 0.25
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            backgroundColor: 'rgba(22, 22, 26, 0.95)',
            titleColor: '#60a5fa',
            bodyColor: '#f8fafc',
            borderColor: 'rgba(96, 165, 250, 0.3)',
            borderWidth: 1,
            padding: 8,
            displayColors: false,
            callbacks: {
              title: (items) => `Date: ${items[0].label}`,
              label: (item) => item.raw == null ? 'n/a' : `${s.name}: ${Number(item.raw).toFixed(2)} ${s.unit}`
            }
          }
        },
        scales: {
          x: {
            min: visibleZoomWindow.start,
            max: visibleZoomWindow.end,
            ticks: {
              color: '#64748b',
              font: { size: 10, family: 'var(--mono)' },
              maxTicksLimit: 11,
              callback: function(val) {
                const label = this.getLabelForValue(val);
                return label ? label.split('-')[0] : '';
              }
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.04)',
              drawBorder: false
            }
          },
          y: {
            ticks: {
              color: '#64748b',
              font: { size: 10, family: 'var(--mono)' },
              callback: (val) => (s.unit.startsWith('$') ? `$${val}` : val)
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              drawBorder: false
            }
          }
        }
      }
    });

    // Synchronized Scrubbing Event Listeners
    canvas.addEventListener('mousemove', (e) => syncHover(e, key));
    canvas.addEventListener('mouseleave', () => clearSyncHover());
  });

  // Attach synchronized wheel / scrolling to container
  const grid = document.getElementById('market-charts-grid');
  if (grid && !grid._hasSyncScroll) {
    grid._hasSyncScroll = true;
    grid.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      handleSyncZoom(delta);
    }, { passive: false });
  }

  // Set initial readouts to the most recent month
  const lastIdx = historical10yData.dates.length - 1;
  updateSyncReadouts(lastIdx);
}

function updateSyncReadouts(idx) {
  if (!historical10yData || idx == null || idx < 0 || idx >= historical10yData.dates.length) return;
  const dateStr = historical10yData.dates[idx];
  const seriesMap = {
    brent: historical10yData.series.brent,
    wti: historical10yData.series.wti,
    spread: historical10yData.series.spread,
    crack: historical10yData.series.crack_321,
    natgas: historical10yData.series.natgas,
  };
  for (const [k, s] of Object.entries(seriesMap)) {
    const el = document.getElementById(`sync-${k}`);
    if (el && s && s.data[idx] != null) {
      el.textContent = `${dateStr}: ${Number(s.data[idx]).toFixed(2)} ${s.unit}`;
    }
  }
}

function syncHover(event, sourceKey) {
  if (isSyncHovering || !historical10yData) return;
  const sourceChart = chartInstances[sourceKey];
  if (!sourceChart) return;

  const points = sourceChart.getElementsAtEventForMode(event, 'index', { intersect: false }, true);
  if (!points || !points.length) return;

  const targetIndex = points[0].index;
  updateSyncReadouts(targetIndex);

  isSyncHovering = true;
  Object.keys(chartInstances).forEach(k => {
    const chart = chartInstances[k];
    if (chart && chart !== sourceChart) {
      chart.setActiveElements([{ datasetIndex: 0, index: targetIndex }]);
      chart.tooltip.setActiveElements([{ datasetIndex: 0, index: targetIndex }]);
      chart.update('none');
    }
  });
  isSyncHovering = false;
}

function clearSyncHover() {
  if (!historical10yData) return;
  const lastIdx = visibleZoomWindow.end;
  updateSyncReadouts(lastIdx);

  Object.keys(chartInstances).forEach(k => {
    const chart = chartInstances[k];
    if (chart) {
      chart.setActiveElements([]);
      chart.tooltip.setActiveElements([]);
      chart.update('none');
    }
  });
}

function handleSyncZoom(delta) {
  if (!historical10yData) return;
  const total = historical10yData.dates.length;
  const minSpan = 12; // 1 year minimum zoom
  const currentSpan = visibleZoomWindow.end - visibleZoomWindow.start;

  if (delta > 0) {
    // Zoom Out / Expand
    const step = 4;
    visibleZoomWindow.start = Math.max(0, visibleZoomWindow.start - step);
    visibleZoomWindow.end = Math.min(total - 1, visibleZoomWindow.end + step);
  } else {
    // Zoom In / Focus
    if (currentSpan > minSpan) {
      const step = 4;
      visibleZoomWindow.start = Math.min(visibleZoomWindow.start + step, visibleZoomWindow.end - minSpan);
      visibleZoomWindow.end = Math.max(visibleZoomWindow.end - step, visibleZoomWindow.start + minSpan);
    }
  }

  // Synchronously update all 6 charts in lockstep
  Object.keys(chartInstances).forEach(k => {
    const chart = chartInstances[k];
    if (chart) {
      chart.options.scales.x.min = visibleZoomWindow.start;
      chart.options.scales.x.max = visibleZoomWindow.end;
      chart.update('none');
    }
  });
}

// ── WebSocket & Live Stream Connection ───────────────────────────────────────
let wsPollingFallbackInterval = null;

function startVesselPollingFallback() {
  if (wsPollingFallbackInterval) return;
  wsPollingFallbackInterval = setInterval(loadInitialVessels, 30000);
}

function connectWS() {
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setStatus('live');
      clearInterval(ws._pingInterval);
      ws._pingInterval = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, PING_MS);
      if (wsPollingFallbackInterval) {
        clearInterval(wsPollingFallbackInterval);
        wsPollingFallbackInterval = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'initial_load' || msg.type === 'vessel_batch') {
          (msg.data || []).forEach(upsertVessel);
          const ts = msg.latest_updated_at || (msg.data && msg.data.length ? msg.data[msg.data.length - 1].updated_at : null);
          if (ts) updateLastSeenTimestamp(ts);
        } else if (msg.type === 'vessel_update' && msg.data) {
          upsertVessel(msg.data);
          if (msg.data.updated_at) updateLastSeenTimestamp(msg.data.updated_at);
        }
      } catch (err) {
        console.warn('Error parsing incoming WS message:', err);
      }
    };

    ws.onerror = () => {
      if (!apiDown) startVesselPollingFallback();
    };

    ws.onclose = () => {
      setStatus('connecting');
      clearInterval(ws._pingInterval);
      if (apiDown) return; // static host: the daily snapshot is all there is
      startVesselPollingFallback();
      // Try to reconnect in 15 seconds if on standard persistent host
      setTimeout(() => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          connectWS();
        }
      }, 15000);
    };
  } catch (err) {
    console.warn('WebSocket not supported in this environment, using REST polling:', err);
    startVesselPollingFallback();
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function loadInitialVessels() {
  try {
    const data = await getJSON('/vessels');
    if (data.vessels && data.vessels.length) {
      data.vessels.forEach(upsertVessel);
    }
    if (data.latest_updated_at) {
      updateLastSeenTimestamp(data.latest_updated_at);
    }
  } catch (e) {
    console.warn('Initial vessels REST fallback failed:', e.message);
  }
}

async function init() {
  const hostEl = document.getElementById('footer-host');
  if (hostEl && location.host) {
    hostEl.textContent = `OilWatch v1.1 · ${location.host}`;
  }
  // Explain an empty map instead of leaving it mysterious.

  initMap();
  connectWS();
  startClock();

  // Initial data load
  await Promise.allSettled([loadInitialVessels(), loadNews(), loadIncidents()]);
  if (!vesselDataStore.size) {
    const el = document.getElementById('vessel-last-updated');
    if (el) el.textContent = 'No tanker snapshot yet';
  }

  // Polling
  setInterval(loadNews,     NEWS_MS);
  setInterval(loadIncidents, INC_MS);
}

window.addEventListener('DOMContentLoaded', init);
