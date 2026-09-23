/* ============================================================
   OilWatch — Frontend Application
   Handles: WebSocket (live vessels), REST polling (news/prices/incidents),
   Leaflet map with shipping lanes, chokepoints, and vessel markers.
   ============================================================ */

'use strict';

// ── Config ───────────────────────────────────────────────────────────────────
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL     = `${wsProtocol}//${location.host}/ws/vessels`;
const API        = '/api';
const NEWS_MS    = 5  * 60 * 1000;   // refresh news every 5 min
const PRICE_MS   = 15 * 60 * 1000;   // refresh prices every 15 min
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
  const clr = risk === 'high' ? '#ef4444' : risk === 'medium' ? '#f59e0b' : '#22c55e';
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
  const clr = severity === 'warning' ? '#ef4444' : '#f59e0b';
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
      style: { color: '#00d4ff', weight: 1, opacity: 0.2, fillOpacity: 0 },
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
  const color = merged.color || (vClass === 'VLCC' ? '#f59e0b' : vClass === 'Suezmax' ? '#00d4ff' : vClass === 'Aframax' ? '#10b981' : '#a855f7');
  const heading = merged.heading ?? merged.cog ?? 0;
  const icon = shipIcon(color, heading, vClass);
  const popup = buildVesselPopup(merged, vClass, color);

  if (vesselMarkers.has(mmsi)) {
    const m = vesselMarkers.get(mmsi);
    m.setLatLng([merged.lat, merged.lon]);
    m.setIcon(icon);
    m.setPopupContent(popup);
  } else {
    const m = L.marker([merged.lat, merged.lon], { icon, zIndexOffset: 200, title: merged.name || mmsi });
    m.bindPopup(popup, { maxWidth: 300, className: 'dark-popup' });
    vesselMarkers.set(mmsi, m);
    // Add to map only if matches active filter
    if (currentVesselFilter === 'all' || vClass === currentVesselFilter) {
      m.addTo(map);
    }
  }

  updateFilterCounts();
}

function buildVesselPopup(v, vClass, color) {
  const name  = v.name  || `MMSI ${v.mmsi}`;
  const speed = v.sog   != null ? `${Number(v.sog).toFixed(1)} kn` : '—';
  const dest  = v.destination || '—';
  const upd   = v.updated_at  ? new Date(v.updated_at).toLocaleTimeString('en-GB') : '—';
  const draught = v.draught ? `${Number(v.draught).toFixed(1)}m` : '—';
  const cargoStatus = v.cargo_status || (v.sog < 0.8 ? 'Storage / Drifting' : 'Underway');
  const cargoClass = cargoStatus.includes('Laden') ? 'pill-laden' : cargoStatus.includes('Ballast') ? 'pill-ballast' : 'pill-storage';

  return `
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span class="tanker-class-tag" style="background:${color}22; color:${color}; border:1px solid ${color}66;">
          ${v.vessel_desc || vClass}
        </span>
        <span class="cargo-pill ${cargoClass}">${cargoStatus}</span>
      </div>
      <div class="popup-title">🚢 ${name}</div>
      <div class="popup-row"><span class="lbl">MMSI</span><span class="val">${v.mmsi}</span></div>
      <div class="popup-row"><span class="lbl">Dimensions</span><span class="val">${v.length || '—'}m &bull; Draft: ${draught}</span></div>
      <div class="popup-row"><span class="lbl">Speed & Course</span><span class="val">${speed} &bull; ${Math.round(v.cog || 0)}&deg;</span></div>
      <div class="popup-row"><span class="lbl">Destination</span><span class="val">${dest}</span></div>
      ${v.callsign ? `<div class="popup-row"><span class="lbl">Callsign</span><span class="val">${v.callsign}</span></div>` : ''}
      <div class="popup-row"><span class="lbl">Last Report</span><span class="val">${upd} UTC</span></div>
      <a class="popup-link" href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}" target="_blank" rel="noopener">
        View on MarineTraffic ↗
      </a>
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

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  setStatus('connecting');
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn('WebSocket init exception:', e);
    setTimeout(connectWS, 4000);
    return;
  }

  ws.onopen = () => {
    setStatus('live');
    // Keep-alive ping every 25 s
    ws._pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, PING_MS);
  };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'initial_load') {
        msg.data.forEach(upsertVessel);
        if (msg.latest_updated_at) {
          updateLastSeenTimestamp(msg.latest_updated_at);
        }
      } else if (msg.type === 'vessel_update') {
        upsertVessel(msg.data);
        if (msg.data && msg.data.updated_at) {
          updateLastSeenTimestamp(msg.data.updated_at);
        }
      }
    } catch (e) { /* ignore */ }
  };

  ws.onclose = () => {
    setStatus('connecting');
    clearInterval(ws._pingInterval);
    setTimeout(connectWS, 4000);
  };

  ws.onerror = () => {
    ws.close();
  };
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
    const { news } = await (await fetch(`${API}/news?limit=20`)).json();
    currentNewsArticles = news || [];
    const list = document.getElementById('news-list');

    if (!news || !news.length) {
      list.innerHTML = '<div class="news-empty">Fetching first batch of news…<br><small>~2 minutes on first run.</small></div>';
      return;
    }

    list.innerHTML = news.map(item => {
      const dateStr = item.published
        ? new Date(item.published).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
        : '';
      const sent = (item.sentiment || 'neutral').toLowerCase();
      const sentBadge = `<span class="news-sentiment sent-${sent}">${sent.toUpperCase()}</span>`;
      return `
        <div class="news-card">
          <div class="news-meta">
            <span class="news-src">${item.source || '—'}</span>
            ${sentBadge}
            <span class="news-date">${dateStr}</span>
          </div>
          <a class="news-title" href="${item.link}" target="_blank" rel="noopener">${item.title}</a>
          ${item.ai_brief ? `<div class="news-brief">🤖 ${item.ai_brief}</div>` : ''}
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
    const { incidents } = await (await fetch(`${API}/incidents`)).json();
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
      m.bindPopup(`
        <div>
          <div class="popup-title">⚠ ${inc.title}</div>
          <div class="popup-row"><span class="lbl">Area</span><span class="val">${inc.area || '—'}</span></div>
          <div class="popup-row"><span class="lbl">Severity</span><span class="val risk-${inc.severity || 'advisory'}">${(inc.severity || 'advisory').toUpperCase()}</span></div>
          <div class="popup-row"><span class="lbl">Source</span><span class="val">${inc.source || 'UKMTO'}</span></div>
          ${shortDesc ? `<p class="popup-desc">${shortDesc}</p>` : ''}
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
        incList.innerHTML = '<div class="news-empty">No active security alerts reported.</div>';
      } else {
        incList.innerHTML = currentIncidents.map(inc => {
          const sevClass = inc.severity === 'warning' ? 'risk-high' : 'risk-medium';
          const dateStr = inc.published_at ? new Date(inc.published_at).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
          const shortDesc = sanitizeSentences(inc.description, 3);
          const safeTitle = (inc.title || '').replace(/'/g, "\\'");
          return `
            <div class="inc-card" onclick="flyToIncident(${inc.lat}, ${inc.lon}, '${safeTitle}')">
              <div class="inc-card-hdr">
                <span class="inc-card-area">📍 ${inc.area || 'Maritime Zone'}</span>
                <span class="inc-card-sev ${sevClass}">${(inc.severity || 'advisory').toUpperCase()}</span>
              </div>
              <div class="inc-card-title">⚠️ ${inc.title}</div>
              <div class="inc-card-desc">${shortDesc}</div>
              <div class="inc-card-meta">
                <span>Source: ${inc.source || 'UKMTO'}</span>
                <span>${dateStr}</span>
              </div>
            </div>`;
        }).join('');
      }
    }
  } catch (e) {
    console.warn('Incidents unavailable:', e.message);
  }
}

function flyToIncident(lat, lon, title) {
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
      const jitterLat = (Math.random() - 0.5) * 1.5;
      const jitterLon = (Math.random() - 0.5) * 2.0;
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
  const clr = sent === 'bullish' ? '#10b981' : sent === 'bearish' ? '#ef4444' : '#00d4ff';
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
          📍 ${loc.regionName}
        </div>
        <div class="popup-title">${art.title}</div>
        <div style="display:flex; gap:8px; align-items:center; margin:6px 0;">
          <span style="font-size:11px; font-weight:700; color:#00d4ff;">${art.source || 'Intel'}</span>
          ${sentBadge}
          <span style="font-size:11px; color:#888;">${dateStr}</span>
        </div>
        ${art.ai_brief ? `<div class="news-brief" style="margin-top:6px; font-size:11.5px; line-height:1.4;">🤖 ${art.ai_brief}</div>` : ''}
        ${art.link ? `<a class="popup-link" href="${art.link}" target="_blank" rel="noopener" style="margin-top:8px; display:inline-block;">Read Original Article ↗</a>` : ''}
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
  if (force || !analysisLoaded) {
    memoEl.innerHTML = '<div class="memo-loading">⏳ Synthesizing market data, marginal cost curves, and AI diagnosis...</div>';
  }

  try {
    const res = await fetch(`${API}/analysis`);
    const data = await res.json();
    analysisLoaded = true;

    const q = data.quotes || {};
    const fv = data.fair_value || {};

    // 1. Live Market Tickers
    document.getElementById('mkt-brent').textContent = q.brent != null ? `$${Number(q.brent).toFixed(2)}` : '--';
    document.getElementById('mkt-wti').textContent = q.wti != null ? `$${Number(q.wti).toFixed(2)}` : '--';
    
    if (fv.brent_wti_spread != null) {
      document.getElementById('mkt-spread').textContent = `+$${Number(fv.brent_wti_spread).toFixed(2)}`;
      document.getElementById('mkt-spread-desc').textContent = fv.spread_assessment || 'Transatlantic Arb';
    }
    document.getElementById('mkt-natgas').textContent = q.natgas != null ? `$${Number(q.natgas).toFixed(2)}` : '--';

    // Crack Spread
    const crackEl = document.getElementById('mkt-crack');
    if (crackEl) {
      crackEl.textContent = q.crack_spread != null ? `$${Number(q.crack_spread).toFixed(2)}` : '--';
    }
    const crackDescEl = document.getElementById('mkt-crack-desc');
    if (crackDescEl && q.crack_spread != null) {
      crackDescEl.textContent = q.crack_spread > 30 ? 'High Margin (Strong Crude Run)' : 'Standard Margin';
    }

    // Term Structure
    const termEl = document.getElementById('mkt-term');
    if (termEl) {
      if (q.timespread != null) {
        termEl.textContent = q.timespread > 0 ? `+${q.timespread.toFixed(2)} Backw.` : `${q.timespread.toFixed(2)} Contango`;
        termEl.style.color = q.timespread > 0 ? '#34d399' : '#f87171';
      } else {
        termEl.textContent = q.term_structure || 'Flat';
      }
    }
    const termDescEl = document.getElementById('mkt-term-desc');
    if (termDescEl) {
      termDescEl.textContent = (q.timespread || 0) > 0 ? 'Prompt Scarcity / Tightness' : 'Inventory Build / Storage';
    }

    // 2. Valuation Status Badge
    const badge = document.getElementById('val-status-badge');
    badge.textContent = fv.valuation || 'Fair Value';
    badge.className = 'val-status-badge';
    if ((fv.valuation || '').includes('Overvalued')) {
      badge.classList.add('overvalued');
    } else if ((fv.valuation || '').includes('Undervalued')) {
      badge.classList.add('undervalued');
    } else {
      badge.classList.add('fair');
    }

    // 3. Rationale & Fair Band
    document.getElementById('val-rationale').textContent = fv.rationale || 'Analysis complete.';
    if (fv.fair_value_min && fv.fair_value_max) {
      document.getElementById('fair-band-range').textContent = `$${fv.fair_value_min.toFixed(2)} - $${fv.fair_value_max.toFixed(2)} / bbl`;
    }

    // 4. AI Memo Content
    if (data.ai_memo) {
      memoEl.textContent = data.ai_memo;
    } else {
      memoEl.innerHTML = '<div class="memo-loading">AI synthesis complete. Configure GEMINI_API_KEY for dynamic commentary.</div>';
    }
  } catch (e) {
    console.error('Error loading analysis:', e);
    memoEl.innerHTML = `<div class="memo-loading" style="color:var(--danger)">Failed to load price discovery model: ${e.message}</div>`;
  }
}

// ── Synchronized 10-Year Historical Charts Engine ─────────────────────────────
let currentAnalysisMode = 'cards';
let historical10yData = null;
let chartInstances = {};
let isSyncHovering = false;
let visibleZoomWindow = { start: 0, end: 128 }; // index range in dates array

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
      const res = await fetch(`${API}/historical-data`);
      historical10yData = await res.json();
      visibleZoomWindow.end = historical10yData.dates.length - 1;
    } catch (e) {
      console.error('Failed to load historical 10Y data:', e);
      return;
    }
  }

  const keys = ['brent', 'wti', 'spread', 'crack', 'timespread', 'natgas'];
  const seriesKeysMap = {
    brent: 'brent',
    wti: 'wti',
    spread: 'spread',
    crack: 'crack_spread',
    timespread: 'timespread',
    natgas: 'natgas'
  };

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
            backgroundColor: 'rgba(7, 12, 28, 0.95)',
            titleColor: '#00d4ff',
            bodyColor: '#f8fafc',
            borderColor: 'rgba(0, 212, 255, 0.3)',
            borderWidth: 1,
            padding: 8,
            displayColors: false,
            callbacks: {
              title: (items) => `Date: ${items[0].label}`,
              label: (item) => `${s.name}: $${Number(item.raw).toFixed(2)} ${s.unit}`
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
              callback: (val) => `$${val}`
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
    crack: historical10yData.series.crack_spread,
    timespread: historical10yData.series.timespread,
    natgas: historical10yData.series.natgas,
  };
  for (const [k, s] of Object.entries(seriesMap)) {
    const el = document.getElementById(`sync-${k}`);
    if (el && s && s.data[idx] != null) {
      const val = Number(s.data[idx]).toFixed(2);
      el.textContent = `${dateStr}: $${val} ${s.unit}`;
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

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function loadInitialVessels() {
  try {
    const res = await fetch(`${API}/vessels`);
    const data = await res.json();
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
