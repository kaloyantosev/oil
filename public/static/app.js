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
let ws;
let sidebarOpen = true;
const vesselMarkers = new Map();   // mmsi → L.marker
const vesselDataStore = new Map(); // mmsi → raw vessel object
let incidentMarkers = [];
let currentVesselFilter = 'all';
let currentNewsArticles = [];
let newsMarkers = [];
let newsOnMapVisible = false;

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

// ── Icons ─────────────────────────────────────────────────────────────────────
function shipIcon(color, headingDeg, vClass) {
  const h = headingDeg || 0;
  const w = vClass === 'VLCC' ? 16 : vClass === 'Suezmax' ? 14 : vClass === 'Aframax' ? 13 : 11;
  const len = vClass === 'VLCC' ? 26 : vClass === 'Suezmax' ? 22 : vClass === 'Aframax' ? 20 : 17;

  // Arrow-shaped SVG ship silhouette
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${len}" viewBox="0 0 14 22">
    <polygon points="7,1 13,21 7,17 1,21" fill="${color}" stroke="rgba(0,0,0,0.7)" stroke-width="1.2"/>
  </svg>`;
  return L.divIcon({
    html: `<div style="transform:rotate(${h}deg);transform-origin:50% 50%;line-height:0">${svg}</div>`,
    className: 'ship-icon',
    iconSize:   [w, len],
    iconAnchor: [w / 2, len / 2],
  });
}

function chokepointIcon(risk) {
  const clr = risk === 'high' ? '#f87171' : risk === 'medium' ? '#fbbf24' : '#34d399';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <polygon points="13,2 24,23 2,23" fill="${clr}" fill-opacity=".25" stroke="${clr}" stroke-width="2"/>
    <rect x="12" y="9" width="2" height="7" fill="${clr}"/>
    <circle cx="13" cy="19" r="1.5" fill="${clr}"/>
  </svg>`;
  return L.divIcon({
    html: svg, className: 'ck-icon',
    iconSize: [26, 26], iconAnchor: [13, 23],
  });
}

function incidentIcon(severity) {
  const clr = severity === 'warning' ? '#f87171' : '#fbbf24';
  return L.divIcon({
    html: `<div style="width:11px;height:11px;background:${clr};border:2px solid #fff;border-radius:50%;box-shadow:0 0 9px ${clr}"></div>`,
    className: 'inc-icon',
    iconSize: [11, 11], iconAnchor: [5.5, 5.5],
  });
}

// ── Map init ─────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [20, 55],
    zoom: 3,
    zoomControl: false,   // Prevents overlap with #map-controls top-left
    attributionControl: true,
    preferCanvas: true,   // better perf for many markers
  });

  // Relocate zoom control to bottom right (clean & uncluttered)
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // ESRI World Dark Gray Canvas — Completely free, dark maritime theme, no API key required
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 16,
  }).addTo(map);

  // Add ESRI reference labels on top so country/city borders and names stay crisp
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    attribution: '',
    maxZoom: 16,
  }).addTo(map);

  loadShippingLanes();
  loadChokepoints();
  loadMajorPorts();
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

function portIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" fill="#3b82f6" fill-opacity="0.3" stroke="#60a5fa" stroke-width="2"/>
    <path d="M12 6v12M8 10l4-4 4 4M7 16h10" stroke="#93c5fd" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: 'port-icon',
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
}

function loadMajorPorts() {
  MAJOR_OIL_PORTS.forEach(port => {
    L.marker(port.coords, {
      icon: portIcon(),
      zIndexOffset: 550,
      title: port.name
    })
    .bindPopup(`
      <div style="min-width:250px">
        <div style="font-size:10px; color:#60a5fa; text-transform:uppercase; font-weight:700; margin-bottom:2px;">⚓ Strategic Oil Port &bull; ${port.country}</div>
        <div class="popup-title">${port.name}</div>
        <div class="popup-row"><span class="lbl">Hub Classification</span><span class="val">${port.type}</span></div>
        <p class="popup-desc">${sanitizeSentences(port.desc, 3)}</p>
      </div>
    `, { maxWidth: 310, className: 'dark-popup' })
    .addTo(map);
  });
}

async function loadShippingLanes() {
  try {
    const r    = await fetch('/static/data/shipping_lanes.geojson');
    const data = await r.json();
    if (!data.features || data.features.length === 0) return;

    L.geoJSON(data, {
      style: { color: '#60a5fa', weight: 1, opacity: 0.2, fillOpacity: 0 },
    }).addTo(map);
    console.log(`Shipping lanes: ${data.features.length} features`);
  } catch (e) {
    console.warn('Shipping lanes unavailable:', e.message);
  }
}

async function loadChokepoints() {
  try {
    const r    = await fetch('/static/data/chokepoints.geojson');
    const data = await r.json();

    data.features.forEach(f => {
      const p  = f.properties;
      const [lon, lat] = f.geometry.coordinates;

      L.marker([lat, lon], {
        icon: chokepointIcon(p.risk_level),
        zIndexOffset: 600,
        title: p.name,
      })
      .bindPopup(buildChokepointPopup(p), { maxWidth: 310, className: 'dark-popup' })
      .addTo(map);
    });

    console.log(`Chokepoints: ${data.features.length} loaded`);
  } catch (e) {
    console.warn('Chokepoints unavailable:', e.message);
  }
}

function buildChokepointPopup(p) {
  const riskClass = `risk-${p.risk_level}`;
  return `
    <div style="min-width:250px">
      <div class="popup-title">⬡ ${p.name}</div>
      <div class="popup-row"><span class="lbl">Daily Volume</span><span class="val">${p.volume_mbpd}M bbl/day</span></div>
      <div class="popup-row"><span class="lbl">Risk Level</span><span class="val ${riskClass}">${p.risk_level.toUpperCase()}</span></div>
      <p class="popup-desc">${sanitizeSentences(p.description, 3)}</p>
    </div>`;
}

// ── Vessel markers ────────────────────────────────────────────────────────────
function upsertVessel(v) {
  if (v.lat == null || v.lon == null) return;
  const mmsi = String(v.mmsi);

  // Merge into vessel data store
  const existing = vesselDataStore.get(mmsi) || {};
  const merged = { ...existing, ...v };
  vesselDataStore.set(mmsi, merged);

  const vClass = merged.vessel_class || (merged.length >= 300 ? 'VLCC' : merged.length >= 240 ? 'Suezmax' : merged.length >= 200 ? 'Aframax' : 'Product');
  const color = merged.color || (vClass === 'VLCC' ? '#fbbf24' : vClass === 'Suezmax' ? '#60a5fa' : vClass === 'Aframax' ? '#10b981' : '#a855f7');
  const heading = merged.heading ?? merged.cog ?? 0;
  const iconKey = `${color}|${vClass}|${Math.round(heading / 10) * 10}`;

  if (vesselMarkers.has(mmsi)) {
    const m = vesselMarkers.get(mmsi);
    m.setLatLng([merged.lat, merged.lon]);
    if (m._iconKey !== iconKey) {
      m.setIcon(shipIcon(color, heading, vClass));
      m._iconKey = iconKey;
    }
    if (m.isPopupOpen()) m.setPopupContent(buildVesselPopup(merged, vClass, color));
  } else {
    const m = L.marker([merged.lat, merged.lon], { icon: shipIcon(color, heading, vClass), zIndexOffset: 200, title: merged.name || mmsi });
    m._iconKey = iconKey;
    // Build popup HTML lazily, from the latest data, when it is opened.
    m.bindPopup(() => {
      const v = vesselDataStore.get(mmsi) || merged;
      return buildVesselPopup(v, v.vessel_class || vClass, v.color || color);
    }, { maxWidth: 300, className: 'dark-popup' });
    vesselMarkers.set(mmsi, m);
    // Add to map only if matches active filter
    if (currentVesselFilter === 'all' || vClass === currentVesselFilter) {
      m.addTo(map);
    }
  }

  scheduleCountUpdate();
}

let countUpdatePending = false;
function scheduleCountUpdate() {
  if (countUpdatePending) return;
  countUpdatePending = true;
  requestAnimationFrame(() => { countUpdatePending = false; updateFilterCounts(); });
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
      <div class="popup-title">🚢 ${name}</div>
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
  if (currentVesselFilter === 'incidents') {
    // Hide all vessels, keep map focused on incidents
    for (const m of vesselMarkers.values()) {
      if (map.hasLayer(m)) m.remove();
    }
    document.getElementById('vessel-count').textContent = '0 (Incidents Mode)';
    showIncidentsFeed();
    return;
  }

  let visibleCount = 0;
  for (const [mmsi, m] of vesselMarkers.entries()) {
    const v = vesselDataStore.get(mmsi);
    const vClass = v ? (v.vessel_class || (v.length >= 300 ? 'VLCC' : v.length >= 240 ? 'Suezmax' : v.length >= 200 ? 'Aframax' : 'Product')) : 'Product';
    const match = currentVesselFilter === 'all' || vClass === currentVesselFilter;
    if (match) {
      if (!map.hasLayer(m)) m.addTo(map);
      visibleCount++;
    } else {
      if (map.hasLayer(m)) m.remove();
    }
  }
  document.getElementById('vessel-count').textContent = visibleCount;
}

function updateFilterCounts() {
  let total = 0, vlcc = 0, suez = 0, afra = 0, prod = 0;
  for (const v of vesselDataStore.values()) {
    total++;
    const vClass = v.vessel_class || (v.length >= 300 ? 'VLCC' : v.length >= 240 ? 'Suezmax' : v.length >= 200 ? 'Aframax' : 'Product');
    if (vClass === 'VLCC') vlcc++;
    else if (vClass === 'Suezmax') suez++;
    else if (vClass === 'Aframax') afra++;
    else prod++;
  }
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('vf-all', total);
  setEl('vf-vlcc', vlcc);
  setEl('vf-suez', suez);
  setEl('vf-afra', afra);
  setEl('vf-prod', prod);
  if (currentVesselFilter === 'all') {
    setEl('vessel-count', total);
  }
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
  const secs = String(dateObj.getUTCSeconds()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hours}:${mins}:${secs} UTC`;
}

function updateLastSeenTimestamp(isoDateStr) {
  const el = document.getElementById('vessel-last-updated');
  if (!el) return;
  if (!isoDateStr) return;
  const d = new Date(isoDateStr);
  el.textContent = formatUtcTimestamp(d);
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
      const sentBadge = `<span class="news-sentiment sent-${sent}" title="Keyword-based tone for oil prices, not a forecast">${sent.toUpperCase()}</span>`;
      return `
        <div class="news-card">
          <div class="news-meta">
            <span class="news-src">${esc(item.source || '—')}</span>
            ${sentBadge}
            <span class="news-date">${dateStr}</span>
          </div>
          <a class="news-title" href="${safeUrl(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a>
          ${item.ai_brief ? `<div class="news-brief">${esc(item.ai_brief)}</div>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    console.warn('News unavailable:', e.message);
  }
}

// ── Incidents ─────────────────────────────────────────────────────────────────
let currentIncidents = [];

async function loadIncidents() {
  try {
    const { incidents } = await getJSON('/incidents');
    currentIncidents = incidents || [];

    // Clear old markers
    incidentMarkers.forEach(m => m.remove());
    incidentMarkers = [];

    let visibleCount = 0;
    (currentIncidents || []).forEach(inc => {
      if (inc.lat == null || inc.lon == null) return;

      const m = L.marker([inc.lat, inc.lon], {
        icon: incidentIcon(inc.severity),
        zIndexOffset: 1000,
        title: inc.title,
      });

      const shortDesc = sanitizeSentences(inc.description, 3);
      const sev = inc.severity === 'warning' ? 'warning' : 'advisory';
      m.bindPopup(`
        <div>
          <div class="popup-title">⚠ ${esc(inc.title)}</div>
          <div class="popup-row"><span class="lbl">Area</span><span class="val">${esc(inc.area || '—')} (area-level position)</span></div>
          <div class="popup-row"><span class="lbl">Type</span><span class="val risk-${sev}">${sev.toUpperCase()}</span></div>
          <div class="popup-row"><span class="lbl">Source</span><span class="val">${esc(inc.source || 'News')}</span></div>
          ${shortDesc ? `<p class="popup-desc">${esc(shortDesc)}</p>` : ''}
          ${inc.link ? `<a class="popup-link" href="${safeUrl(inc.link)}" target="_blank" rel="noopener">Read the report ↗</a>` : ''}
        </div>
      `, { maxWidth: 300, className: 'dark-popup' });

      m.addTo(map);
      incidentMarkers.push(m);
      visibleCount++;
    });

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('incident-count', visibleCount);
    setEl('sb-inc-count', visibleCount);
    setEl('vf-inc', visibleCount);

    // Populate the sidebar incidents feed
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
                <span class="inc-card-area">📍 ${esc(inc.area || 'Maritime area')}</span>
                <span class="inc-card-sev ${sevClass}">${inc.severity === 'warning' ? 'WARNING' : 'ADVISORY'}</span>
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
  map.flyTo([lat, lon], 7, { duration: 1.2 });
  const m = incidentMarkers.find(marker => {
    const pos = marker.getLatLng();
    return Math.abs(pos.lat - lat) < 0.001 && Math.abs(pos.lng - lon) < 0.001;
  });
  if (m) {
    setTimeout(() => m.openPopup(), 1250);
  }
}

function showIncidentsFeed() {
  if (!sidebarOpen) toggleSidebar();
  switchSidebarTab('incidents');
  if (incidentMarkers.length > 0 && map) {
    const group = L.featureGroup(incidentMarkers);
    map.flyToBounds(group.getBounds(), { padding: [60, 60], maxZoom: 6, duration: 1.2 });
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
  if (sidebarOpen) {
    if (sb) sb.classList.remove('collapsed');
    if (reopenBtn) reopenBtn.classList.remove('visible');
  } else {
    if (sb) sb.classList.add('collapsed');
    if (reopenBtn) reopenBtn.classList.add('visible');
  }
  if (map) {
    setTimeout(() => map.invalidateSize(), 300);
  }
}

// ── Geographic News Distribution on Map ──────────────────────────────────────
function geocodeNews(article) {
  const text = `${article.title || ''} ${article.summary || ''} ${article.ai_brief || ''}`.toLowerCase();
  for (const region of NEWS_GEO_REGIONS) {
    if (region.keywords.some(kw => text.includes(kw))) {
      // Add slight jitter so multiple pins in the same region don't perfectly overlap
      let h = 0;
      for (const ch of (article.link || article.title || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
      const jitterLat = (((h & 0xff) / 255) - 0.5) * 1.5;
      const jitterLon = ((((h >> 8) & 0xff) / 255) - 0.5) * 2.0;
      return {
        lat: region.coords[0] + jitterLat,
        lon: region.coords[1] + jitterLon,
        regionName: region.name
      };
    }
  }
  return null;
}

function newsMapIcon(sentiment) {
  const sent = (sentiment || 'neutral').toLowerCase();
  const clr = sent === 'bullish' ? '#10b981' : sent === 'bearish' ? '#f87171' : '#60a5fa';
  return L.divIcon({
    html: `
      <div class="news-map-pin">
        <div class="news-pin-pulse" style="border-color:${clr}; background:${clr}33;"></div>
        <div class="news-pin-icon" style="background:${clr};">📰</div>
      </div>
    `,
    className: 'news-pin-wrapper',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14]
  });
}

function toggleNewsOnMap() {
  newsOnMapVisible = !newsOnMapVisible;
  const btn = document.getElementById('btn-plot-news');

  if (!newsOnMapVisible) {
    newsMarkers.forEach(m => m.remove());
    newsMarkers = [];
    if (btn) {
      btn.classList.remove('active');
      btn.textContent = '📍 Plot on Map';
    }
    return;
  }

  if (btn) {
    btn.classList.add('active');
    btn.textContent = '✖ Clear Pins';
  }

  // Clear any existing pins
  newsMarkers.forEach(m => m.remove());
  newsMarkers = [];

  const plottedBounds = [];

  (currentNewsArticles || []).forEach(art => {
    const loc = geocodeNews(art);
    if (!loc) return;

    const icon = newsMapIcon(art.sentiment);
    const m = L.marker([loc.lat, loc.lon], { icon, zIndexOffset: 700 });

    const sent = (art.sentiment || 'neutral').toLowerCase();
    const sentBadge = `<span class="news-sentiment sent-${sent}">${sent.toUpperCase()}</span>`;
    const dateStr = art.published
      ? new Date(art.published).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
      : '';

    const popupHtml = `
      <div class="news-map-popup">
        <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">
          📍 ${esc(loc.regionName)} (approximate)
        </div>
        <div class="popup-title">${esc(art.title)}</div>
        <div style="display:flex; gap:8px; align-items:center; margin:6px 0;">
          <span style="font-size:11px; font-weight:700; color:var(--accent);">${esc(art.source || 'News')}</span>
          ${sentBadge}
          <span style="font-size:11px; color:#888;">${dateStr}</span>
        </div>
        ${art.ai_brief ? `<div class="news-brief" style="margin-top:6px; font-size:11.5px; line-height:1.4;">🤖 ${esc(art.ai_brief)}</div>` : ''}
        ${art.link ? `<a class="popup-link" href="${safeUrl(art.link)}" target="_blank" rel="noopener" style="margin-top:8px; display:inline-block;">Read original article ↗</a>` : ''}
      </div>
    `;

    m.bindPopup(popupHtml, { maxWidth: 320, className: 'dark-popup' });
    m.addTo(map);
    newsMarkers.push(m);
    plottedBounds.push([loc.lat, loc.lon]);
  });

  if (plottedBounds.length > 0) {
    map.flyToBounds(plottedBounds, { padding: [50, 50], maxZoom: 5, duration: 1.5 });
  }
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
    if (map) {
      setTimeout(() => map.invalidateSize(), 150);
    }
  } else if (viewName === 'analysis') {
    document.getElementById('tab-analysis-btn').classList.add('active');
    document.getElementById('view-analysis').classList.add('active');
    loadAnalysis();
  }
}

// ── Price Discovery & Valuation Model ─────────────────────────────────────────
let analysisLoaded = false;

async function loadAnalysis(force = false) {
  const memoEl = document.getElementById('ai-memo-content');
  const factsEl = document.getElementById('facts-list');
  if (force || !analysisLoaded) {
    memoEl.innerHTML = '<div class="memo-loading">Loading…</div>';
  }

  try {
    const data = await getJSON('/analysis');
    analysisLoaded = true;

    if (!data.available) {
      factsEl.innerHTML = `<li>${esc(data.error || 'Market data unavailable.')}</li>`;
      memoEl.innerHTML = '<div class="memo-loading">No commentary without market data.</div>';
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

    if (data.ai_commentary) {
      memoEl.textContent = data.ai_commentary;
    } else {
      memoEl.innerHTML = '<div class="memo-loading">Set GEMINI_API_KEY to add AI commentary. The facts on the left are computed directly from market data.</div>';
    }
  } catch (e) {
    console.error('Error loading analysis:', e);
    memoEl.innerHTML = `<div class="memo-loading" style="color:var(--danger)">Failed to load market data: ${esc(e.message)}</div>`;
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
      startVesselPollingFallback();
    };

    ws.onclose = () => {
      setStatus('connecting');
      clearInterval(ws._pingInterval);
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
  getJSON('/health').then(h => {
    if (!h.ais_enabled) {
      const el = document.getElementById('vessel-last-updated');
      if (el) el.textContent = h.mode !== 'persistent' ? 'Live AIS needs a persistent host' : 'Set AISSTREAM_API_KEY for live tankers';
    }
  }).catch(() => {});

  initMap();
  connectWS();
  startClock();

  // Initial data load
  await Promise.allSettled([loadInitialVessels(), loadNews(), loadIncidents()]);

  // Polling
  setInterval(loadNews,     NEWS_MS);
  setInterval(loadIncidents, INC_MS);
}

window.addEventListener('DOMContentLoaded', init);
