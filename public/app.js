import { createLibrary, featuresFromParcels, recordsFromText } from '/lib/library.js';
import { OWNER_COLORS, isCondo, neighborBenchmarks, parties, perAcre, placesDiffer } from '/lib/ownership.js';
import { fetchShared, loadKey, pushShared, saveKey, saveLocal, shareWithServer } from './persist.js';

const emptyNode = document.querySelector('#empty');
const workspaceNode = document.querySelector('#workspace');
const replaceNode = document.querySelector('#replace');
const ownersNode = document.querySelector('#owners');
const resultsNode = document.querySelector('#results');
const detailNode = document.querySelector('#detail');
const compsNode = document.querySelector('#comps');
const mapNode = document.querySelector('#map');
const explainButton = document.querySelector('#explain');
const askWrap = document.querySelector('#ask-wrap');
const askInput = document.querySelector('#ask');
const explanationNode = document.querySelector('#explanation');
const searchesNode = document.querySelector('#searches');
const statusNode = document.querySelector('#status');
const fileInput = document.querySelector('#file');
const drop = document.querySelector('#drop');

let library = createLibrary();
let searches = [];
let changes = { gained: [], lost: [] };
let outreach = {};
let links = {};
let indexedFeatures = [];
let moveTimer = null;
const CONTACT_STATUS = {
  contact: 'Want to contact',
  called: 'Called',
  pass: 'Not interested',
};
let selected = null;
let current = null;
let map = null;
let parcelLayer = null;
let focusIds = new Set();
const ownerColorMap = new Map();
let importToken = 0;
let pendingFileKey = '';
let openOwnerKey = '';
let neighborMap = new Map();
let area = null;
let areaLayer = null;
let draftLayer = null;
let drawMode = false;
let dragStart = null;
let savedZoning = '';
// in: the server's database holds the parcels; off: only this browser does.
let serverMode = 'off';
let aiReady = false;
// Sale prices and ownership splits typed on any device, by parcel number.
let edits = {};
let editsShared = false;
let knownImportId = null;
let serverParcels = 0;
let syncing = false;
let toastTimer = null;
const askAllNode = document.querySelector('#ask-all');
const askAllInput = document.querySelector('#ask-all-input');
const askAllButton = document.querySelector('#ask-all-button');
const askAllAnswer = document.querySelector('#ask-all-answer');
const toastNode = document.querySelector('#toast');

function pct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function acres(value) {
  return value == null ? '' : `${Number(value).toFixed(2)} ac`;
}

function money(value) {
  if (value == null || Number.isNaN(Number(value))) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function showWorkspace(hasParcels) {
  emptyNode.hidden = hasParcels;
  workspaceNode.hidden = !hasParcels;
  replaceNode.hidden = !hasParcels;
  document.querySelector('#clear').hidden = !hasParcels || serverMode === 'in';
  document.querySelector('#export').hidden = !hasParcels;
  document.querySelector('#labels').hidden = !hasParcels;
  askAllNode.hidden = !hasParcels || serverMode !== 'in' || !aiReady;
  showSyncNote();
}

// Parcel numbers in an AI answer become links to that parcel.
function renderAnswer(node, text, lookups = []) {
  node.replaceChildren();
  const known = new Set(library.parcels.map((parcel) => parcel.parcelno));
  let last = 0;
  for (const match of String(text).matchAll(/[0-9A-Z][0-9A-Z~-]{4,}/g)) {
    if (!known.has(match[0])) continue;
    node.append(text.slice(last, match.index));
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'parcel-link';
    link.textContent = match[0];
    link.addEventListener('click', () => showParcel(match[0]));
    node.append(link);
    last = match.index + match[0].length;
  }
  node.append(text.slice(last));
  if (lookups.length) {
    const note = document.createElement('p');
    note.className = 'fine';
    note.textContent = `Checked the database ${lookups.length} ${lookups.length === 1 ? 'time' : 'times'}.`;
    node.append(note);
  }
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  try {
    const body = JSON.parse(raw);
    return { ...body, text: body.text || (Array.isArray(body.message) ? body.message.join(' ') : body.message) || body.error };
  } catch {
    return { text: raw };
  }
}

function rateLabel(value, size) {
  const rate = perAcre(value, size);
  return rate == null ? '' : `${money(rate)}/ac`;
}

function addLabel(parent, text) {
  const label = document.createElement('p');
  label.className = 'sheet-label';
  label.textContent = text;
  parent.append(label);
}

function addFacts(parent, title, rows) {
  const filled = rows.filter(([, value]) => value != null && String(value).trim() !== '');
  if (!filled.length) return;
  if (title) addLabel(parent, title);
  const list = document.createElement('dl');
  list.className = 'facts';
  for (const [label, value] of filled) {
    const wrap = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = String(value);
    wrap.append(term, detail);
    list.append(wrap);
  }
  parent.append(list);
}

function badge(text, kind) {
  const node = document.createElement('span');
  node.className = `badge ${kind}`;
  node.textContent = text;
  return node;
}

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function showToast(text) {
  toastNode.textContent = text;
  toastNode.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.hidden = true;
  }, 12000);
}

const peekNode = document.querySelector('#peek');
let detailInView = false;

// On phones the details sit below the map; this bar jumps to them.
function showPeek(title, sub) {
  document.querySelector('#peek-title').textContent = title || '';
  document.querySelector('#peek-sub').textContent = sub || '';
  peekNode.hidden = !title;
  peekNode.classList.toggle('away', detailInView);
}

peekNode.addEventListener('click', () => {
  document.querySelector('#detail-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
});

if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    detailInView = entries.some((entry) => entry.isIntersecting);
    peekNode.classList.toggle('away', detailInView);
  }, { threshold: 0.15 }).observe(document.querySelector('#detail-panel'));
}

function statStrip(rows) {
  const list = document.createElement('dl');
  list.className = 'stats';
  for (const [label, value] of rows) {
    const wrap = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    wrap.append(term, detail);
    list.append(wrap);
  }
  return list;
}

function showExplain(on) {
  explainButton.hidden = !on;
  askWrap.hidden = !on;
  if (!on) {
    explanationNode.textContent = '';
    askInput.value = '';
  }
}

function markOwner(key) {
  openOwnerKey = key || '';
  for (const row of ownersNode.querySelectorAll('[data-owner]')) {
    row.classList.toggle('is-on', row.dataset.owner === openOwnerKey);
    row.setAttribute('aria-current', row.dataset.owner === openOwnerKey ? 'true' : 'false');
  }
}

async function remember(kind, query) {
  const text = String(query || '').trim();
  if (!text) return;
  const latest = searches[0];
  if (latest && latest.kind === kind && latest.query === text) return;
  searches.unshift({ kind, query: text });
  searches = searches.slice(0, 12);
  renderSearches();
  await saveKey('searches', searches);
}

function paintColors() {
  ownerColorMap.clear();
  const ranked = library.ownerReport({ privateOnly: false, limit: OWNER_COLORS.length });
  ranked.shown.forEach((owner, index) => ownerColorMap.set(owner.ownerKey, OWNER_COLORS[index]));
}

function primaryParty(parcel) {
  const list = parties(parcel.owner_name, parcel.owner_2, parcel.shares);
  if (!list.length) return null;
  return list.reduce((best, party) => (party.share > best.share ? party : best));
}

function primaryOwnerKey(parcel) {
  const party = primaryParty(parcel);
  return party ? library.resolve(party.key) : '';
}

function refreshNeighbors() {
  neighborMap = neighborBenchmarks(library.parcels);
}

function boxActive() {
  return document.querySelector('#private').checked
    || document.querySelector('#absentee').checked
    || document.querySelector('#condos').checked
    || document.querySelector('#below').checked
    || document.querySelector('#waterfront').checked
    || document.querySelector('#zoning').value
    || Number(String(document.querySelector('#min-acres').value || '').replace(/[$,]/g, '')) > 0
    || Number(String(document.querySelector('#max-acre').value || '').replace(/[$,]/g, '')) > 0
    || area;
}

function parcelPasses(parcel) {
  if (document.querySelector('#private').checked && primaryParty(parcel)?.publicOwner) return false;
  if (document.querySelector('#absentee').checked && !placesDiffer(parcel.mailing_city, parcel.loc_city)) return false;
  if (document.querySelector('#condos').checked && isCondo(parcel)) return false;
  if (document.querySelector('#waterfront').checked && !(Number(parcel.waterfront) > 0)) return false;
  if (document.querySelector('#below').checked && !neighborMap.get(parcel.parcelno)?.below) return false;
  const zoning = document.querySelector('#zoning').value;
  if (zoning && String(parcel.zoning || '') !== zoning) return false;
  const minAcres = Number(String(document.querySelector('#min-acres').value || '').replace(/[$,]/g, ''));
  if (Number.isFinite(minAcres) && minAcres > 0 && !(Number(parcel.acres) >= minAcres)) return false;
  const max = Number(String(document.querySelector('#max-acre').value || '').replace(/[$,]/g, ''));
  if (Number.isFinite(max) && max > 0) {
    const rate = perAcre(parcel.total_value, parcel.acres);
    if (rate == null || rate > max) return false;
  }
  if (area) {
    const box = bboxOf(parcel.geometry);
    const bounds = L.latLngBounds([area.south, area.west], [area.north, area.east]);
    if (!box || !intersects(box, bounds)) return false;
  }
  return true;
}

function matchedLibrary() {
  const rows = library.parcels.filter(parcelPasses);
  const view = rows.length ? createLibrary(rows) : createLibrary();
  view.setLinks(links);
  return view;
}

async function saveBuyBox() {
  await saveKey('buybox', {
    privateOnly: document.querySelector('#private').checked,
    absentee: document.querySelector('#absentee').checked,
    skipCondos: document.querySelector('#condos').checked,
    below: document.querySelector('#below').checked,
    waterfront: document.querySelector('#waterfront').checked,
    zoning: document.querySelector('#zoning').value,
    minAcres: document.querySelector('#min-acres').value,
    maxAcre: document.querySelector('#max-acre').value,
    area,
  });
}

function applyBuyBox() {
  saveBuyBox();
  renderOwners();
  if (map) drawVisible();
}

function fillZoning() {
  const select = document.querySelector('#zoning');
  const current = savedZoning || select.value;
  savedZoning = '';
  const zones = [...new Set(library.parcels.map((parcel) => parcel.zoning).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  select.replaceChildren(new Option('All zoning', ''));
  for (const zone of zones) select.append(new Option(zone, zone));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderOwners() {
  paintColors();
  fillZoning();
  const narrowed = boxActive();
  const source = narrowed ? matchedLibrary() : library;
  const report = source.ownerReport({ privateOnly: false, limit: 100 });
  const fileReport = library.ownerReport({ privateOnly: false, limit: 1 });
  const missingValue = !library.parcels.some((parcel) => Number(parcel.total_value) > 0);
  const stats = statStrip([
    ['Parcels', (narrowed ? report.parcels : fileReport.parcels).toLocaleString()],
    ['Acres', (narrowed ? report.acres : fileReport.acres).toFixed(1)],
    ['Owners', (narrowed ? report.owners : fileReport.owners).toLocaleString()],
    ['Assessed', (narrowed ? report.value : fileReport.value) ? money(narrowed ? report.value : fileReport.value) : '—'],
  ]);
  const caption = document.createElement('p');
  caption.className = 'fine';
  const shown = report.shown.length;
  const listNote = report.owners > shown ? `Showing the ${shown} largest. ` : '';
  caption.textContent = narrowed
    ? `${listNote}Share is of the acres that match the buy box.`
    : `${listNote}Share is of the acres in the file. Tap an owner for the mailing address.`;
  const list = document.createElement('div');
  list.className = 'owner-list';
  list.setAttribute('role', 'list');
  const head = document.createElement('div');
  head.className = 'owner-head';
  for (const label of ['Owner', 'Acres', 'Assessed']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    head.append(cell);
  }
  list.append(head);
  for (const owner of report.shown) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'owner-row';
    row.setAttribute('role', 'listitem');
    row.dataset.owner = owner.ownerKey;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = ownerColorMap.get(owner.ownerKey) || '#8d8478';
    const name = document.createElement('span');
    name.className = 'owner-name';
    const strong = document.createElement('strong');
    strong.textContent = owner.publicOwner ? `${owner.name} (public)` : owner.name;
    const meta = document.createElement('small');
    const bits = [`${owner.parcelCount} ${owner.parcelCount === 1 ? 'parcel' : 'parcels'}`];
    if (outreach[owner.ownerKey]?.status) bits.push(CONTACT_STATUS[outreach[owner.ownerKey].status]);
    meta.textContent = bits.join(' · ');
    name.append(strong, meta);
    const land = document.createElement('span');
    land.className = 'num owner-acres';
    land.textContent = acres(owner.acres);
    const share = document.createElement('small');
    share.textContent = pct(owner.acreShare);
    land.append(share);
    const value = document.createElement('span');
    value.className = 'num';
    value.textContent = money(owner.value);
    const per = document.createElement('small');
    per.textContent = rateLabel(owner.value, owner.acres);
    value.append(per);
    row.append(swatch, name, land, value);
    row.addEventListener('click', () => showOwner(owner.ownerKey));
    list.append(row);
  }
  const nodes = [stats, caption, list];
  if (missingValue) {
    const note = document.createElement('p');
    note.className = 'fine';
    note.id = 'value-note';
    note.textContent = 'This file has no assessed values. Download owners and mailing again, then use Replace file.';
    nodes.unshift(note);
  }
  ownersNode.replaceChildren(...nodes);
  markOwner(openOwnerKey);
}

function placeOf(parcelno) {
  const parcel = library.parcels.find((item) => item.parcelno === parcelno);
  const street = String(parcel?.location || '').trim();
  const town = String(parcel?.loc_city || '').trim();
  const owner = String(parcel?.owner_name || '').trim();
  if (street) return { title: street, sub: [town, owner].filter(Boolean).join(' · ') || `Parcel ${parcelno}` };
  if (owner) return { title: owner, sub: [town, `Parcel ${parcelno}`].filter(Boolean).join(' · ') };
  return { title: `Parcel ${parcelno}`, sub: town };
}

function renderSearches() {
  document.querySelector('#recent-title').hidden = searches.length === 0;
  searchesNode.replaceChildren();
  for (const search of searches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent';
    const title = document.createElement('strong');
    const sub = document.createElement('small');
    if (search.kind === 'comps') {
      const place = placeOf(search.query);
      title.textContent = place.title;
      sub.textContent = place.sub;
      button.title = `Parcel ${search.query}`;
    } else {
      title.textContent = search.query;
      sub.textContent = 'Search';
      button.classList.add('is-search');
    }
    button.append(title, sub);
    button.addEventListener('click', () => {
      if (search.kind === 'comps') showParcel(search.query);
      else searchParcels(search.query);
    });
    searchesNode.append(button);
  }
}

function resultTable(rows) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Address', 'Owner', 'Acres', 'Assessed']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    if (label === 'Acres' || label === 'Assessed') cell.className = 'num';
    head.append(cell);
  }
  table.append(head);
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    const cells = [
      row.location || `Parcel ${row.parcelno}`,
      row.owner_name || '',
      acres(row.acres),
      money(row.total_value),
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index >= 2) cell.className = 'num';
      if (index === 0) {
        const strong = document.createElement('strong');
        strong.textContent = value;
        const sub = document.createElement('span');
        sub.className = 'fine';
        sub.textContent = [row.loc_city, row.location ? row.parcelno : ''].filter(Boolean).join(' · ');
        cell.append(strong, sub);
      } else {
        cell.textContent = value;
      }
      if (index === 0 && row.owner_changed_at) cell.append(' ', badge('Owner changed', 'changed'));
      if (index === 0 && row.missing_since) cell.append(' ', badge('Missing', 'missing'));
      tr.append(cell);
    });
    tr.addEventListener('click', () => showParcel(row.parcelno));
    table.append(tr);
  }
  return table;
}

async function searchParcels(query) {
  document.querySelector('#q').value = query;
  const rows = library.search(query);
  document.querySelector('#results-title').hidden = false;
  if (!rows.length) resultsNode.textContent = 'No parcels matched.';
  else resultsNode.replaceChildren(resultTable(rows));
  focusIds = new Set(rows.map((row) => row.parcelno));
  refreshStyles();
  zoomTo(focusIds);
  await remember('search', query);
}

function neighborLine(parcelno) {
  const bench = neighborMap.get(parcelno);
  if (!bench) return '';
  const comparison = `${money(bench.rate)}/ac, nearby median ${money(bench.median)}/ac`;
  return bench.below ? `${comparison}, below neighbors` : comparison;
}

function styleFor(feature) {
  const fill = ownerColorMap.get(feature.properties.ownerKey) || '#8d8478';
  const id = feature.properties.parcelno;
  const dash = feature.properties.missing ? { dashArray: '4 4' } : {};
  const edge = feature.properties.changed ? '#f2b84b' : '#fffaf3';
  if (id === selected) return { color: edge, weight: 3, fillColor: fill, fillOpacity: 0.85, ...dash };
  if (focusIds.has(id)) return { color: edge, weight: 2.5, fillColor: fill, fillOpacity: 0.7, ...dash };
  return { color: edge, weight: feature.properties.changed ? 2 : 1.2, fillColor: fill, fillOpacity: feature.properties.missing ? 0.25 : 0.55, ...dash };
}

function refreshStyles() {
  if (parcelLayer) parcelLayer.setStyle(styleFor);
}

function bboxOf(geometry) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let count = 0;
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      count += 1;
      minLon = Math.min(minLon, node[0]);
      maxLon = Math.max(maxLon, node[0]);
      minLat = Math.min(minLat, node[1]);
      maxLat = Math.max(maxLat, node[1]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry?.coordinates);
  if (!count) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function intersects(box, bounds) {
  if (!box || !bounds) return true;
  return box.maxLat >= bounds.getSouth() && box.minLat <= bounds.getNorth()
    && box.maxLon >= bounds.getWest() && box.minLon <= bounds.getEast();
}

function zoomTo(ids) {
  if (!map) return;
  const bounds = L.latLngBounds([]);
  for (const parcel of library.parcels) {
    if (ids?.size && !ids.has(parcel.parcelno)) continue;
    const box = bboxOf(parcel.geometry);
    if (box) bounds.extend([[box.minLat, box.minLon], [box.maxLat, box.maxLon]]);
  }
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
}

function goToParcel(parcelno, { scroll = true } = {}) {
  if (!map || mapNode.hidden) return;
  const parcel = library.parcels.find((item) => item.parcelno === parcelno);
  const box = bboxOf(parcel?.geometry);
  if (!box) return;
  if (scroll) mapNode.scrollIntoView({ block: 'start', behavior: 'smooth' });
  map.flyToBounds([[box.minLat, box.minLon], [box.maxLat, box.maxLon]], { padding: [60, 60], maxZoom: 18, duration: 0.8 });
}

function renderChanges() {
  const section = document.querySelector('#changes');
  const list = document.querySelector('#change-list');
  const lines = [
    ...(changes.gained || []).map((row) => `${row.name} gained ${row.count} ${row.count === 1 ? 'parcel' : 'parcels'}`),
    ...(changes.lost || []).map((row) => `${row.name} lost ${row.count} ${row.count === 1 ? 'parcel' : 'parcels'}`),
  ];
  list.replaceChildren(...lines.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  section.hidden = lines.length === 0;
}

function indexFeatures() {
  indexedFeatures = library.parcels.filter((parcel) => parcel.geometry).map((parcel) => ({
    type: 'Feature',
    geometry: parcel.geometry,
    bbox: bboxOf(parcel.geometry),
    properties: {
      parcelno: parcel.parcelno,
      ownerKey: primaryOwnerKey(parcel),
      ownerName: parcel.owner_name || 'No owner',
      changed: Boolean(parcel.owner_changed_at),
      missing: Boolean(parcel.missing_since),
    },
  }));
}

function drawVisible() {
  if (!map) return;
  let view = null;
  try {
    const bounds = map.getBounds();
    view = bounds?.isValid() ? bounds.pad(0.2) : null;
  } catch {
    view = null;
  }
  const byParcel = new Map(library.parcels.map((parcel) => [parcel.parcelno, parcel]));
  const visible = indexedFeatures.filter((feature) => {
    const parcel = byParcel.get(feature.properties.parcelno);
    return parcel && (parcelPasses(parcel) || parcel.parcelno === selected) && intersects(feature.bbox, view);
  });
  if (parcelLayer) map.removeLayer(parcelLayer);
  parcelLayer = L.geoJSON({ type: 'FeatureCollection', features: visible }, {
    style: styleFor,
    onEachFeature(feature, layer) {
      const parcel = byParcel.get(feature.properties.parcelno);
      const tip = [
        feature.properties.parcelno,
        feature.properties.ownerName,
        acres(parcel?.acres),
        money(parcel?.total_value),
        feature.properties.changed ? 'Owner changed' : '',
        feature.properties.missing ? 'Missing from the latest file' : '',
      ].filter(Boolean).join(' · ');
      layer.bindTooltip(tip, { sticky: true });
      layer.on('click', () => showParcel(feature.properties.parcelno, { fromMap: true }));
    },
  }).addTo(map);
  mapNode.dataset.shown = String(visible.length);
  const legend = document.querySelector('#map-legend');
  if (!mapNode.hidden) {
    legend.hidden = false;
    legend.textContent = `${visible.length.toLocaleString()} parcels in this view. Each color is one of the largest owners. The buy box filters this map and the owner list.`;
  }
  const note = document.querySelector('#map-note');
  const anyGeometry = indexedFeatures.length > 0;
  const anyMatch = library.parcels.some((parcel) => parcel.geometry && parcelPasses(parcel));
  if (anyGeometry && !anyMatch) {
    note.hidden = false;
    note.textContent = 'No parcels match these filters.';
  } else if (anyGeometry) {
    note.hidden = true;
  }
}

function showMap({ fit = true } = {}) {
  paintColors();
  indexFeatures();
  const note = document.querySelector('#map-note');
  const features = indexedFeatures;
  if (!features.length) {
    mapNode.hidden = true;
    document.querySelector('#map-legend').hidden = true;
    note.hidden = false;
    note.textContent = 'This file has the owners and no parcel outlines. Drop the .geojson to see the map.';
    if (map) {
      map.remove();
      map = null;
      parcelLayer = null;
      areaLayer = null;
      draftLayer = null;
    }
    return;
  }
  note.hidden = true;
  mapNode.hidden = false;
  mapNode.getBoundingClientRect();
  if (!map) {
    map = L.map(mapNode, { preferCanvas: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles © Esri',
    }).addTo(map);
    map.on('moveend', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(drawVisible, 120);
    });
    map.on('mousedown', (event) => {
      if (!drawMode) return;
      L.DomEvent.stop(event.originalEvent);
      dragStart = event.latlng;
      if (draftLayer) map.removeLayer(draftLayer);
      draftLayer = L.rectangle(L.latLngBounds(event.latlng, event.latlng), {
        color: '#b8613a',
        weight: 2,
        dashArray: '4 4',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
    });
    map.on('mousemove', (event) => {
      if (!drawMode || !dragStart || !draftLayer) return;
      draftLayer.setBounds(L.latLngBounds(dragStart, event.latlng));
    });
    map.on('mouseup', (event) => {
      if (!drawMode || !dragStart) return;
      L.DomEvent.stop(event.originalEvent);
      finishDraw(event.latlng);
    });
  }
  const place = () => {
    map.invalidateSize();
    if (fit) {
      const bounds = L.latLngBounds([]);
      for (const feature of indexedFeatures) {
        if (feature.bbox) bounds.extend([[feature.bbox.minLat, feature.bbox.minLon], [feature.bbox.maxLat, feature.bbox.maxLon]]);
      }
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
    }
    showArea();
    drawVisible();
  };
  requestAnimationFrame(place);
  setTimeout(place, 250);
}

function syncDrawButton() {
  const button = document.querySelector('#draw');
  button.textContent = area ? 'Clear area' : 'Draw an area';
  mapNode.classList.toggle('drawing', drawMode);
}

function showArea() {
  if (!map) return;
  if (areaLayer) {
    map.removeLayer(areaLayer);
    areaLayer = null;
  }
  if (!area) return;
  areaLayer = L.rectangle([[area.south, area.west], [area.north, area.east]], {
    color: '#b8613a',
    weight: 2,
    fillColor: '#b8613a',
    fillOpacity: 0.12,
    interactive: false,
  }).addTo(map);
}

function finishDraw(end) {
  const south = Math.min(dragStart.lat, end.lat);
  const north = Math.max(dragStart.lat, end.lat);
  const west = Math.min(dragStart.lng, end.lng);
  const east = Math.max(dragStart.lng, end.lng);
  dragStart = null;
  if (draftLayer && map) {
    map.removeLayer(draftLayer);
    draftLayer = null;
  }
  drawMode = false;
  if (map) map.dragging.enable();
  if ((north - south) < 0.0001 && (east - west) < 0.0001) {
    syncDrawButton();
    statusNode.textContent = 'Drag a larger area.';
    return;
  }
  area = { south, west, north, east };
  showArea();
  syncDrawButton();
  statusNode.textContent = '';
  applyBuyBox();
}

function beginDraw() {
  if (!map) {
    statusNode.textContent = 'Drop the .geojson to draw an area on the map.';
    return;
  }
  drawMode = true;
  dragStart = null;
  map.dragging.disable();
  syncDrawButton();
  statusNode.textContent = 'Drag a rectangle on the map.';
}

function clearDrawnArea() {
  area = null;
  drawMode = false;
  dragStart = null;
  if (draftLayer && map) {
    map.removeLayer(draftLayer);
    draftLayer = null;
  }
  if (areaLayer && map) {
    map.removeLayer(areaLayer);
    areaLayer = null;
  }
  if (map) map.dragging.enable();
  syncDrawButton();
}

async function showParcel(parcelno, { fromMap = false } = {}) {
  const found = library.comps(parcelno);
  if (!found) {
    detailNode.textContent = 'That parcel is not in the saved file.';
    compsNode.replaceChildren();
    showExplain(false);
    return;
  }
  selected = parcelno;
  current = found;
  markOwner('');
  const subject = found.subject;
  const place = placeOf(subject.parcelno);
  document.querySelector('#detail-title').textContent = subject.location || place.title;
  detailNode.replaceChildren();
  const idLine = document.createElement('p');
  idLine.className = 'fine parcel-id';
  idLine.textContent = [`Parcel ${subject.parcelno}`, subject.locCity].filter(Boolean).join(' · ');
  detailNode.append(idLine);
  showPeek(subject.location || place.title, subject.ownerName || `Parcel ${subject.parcelno}`);
  const who = document.createElement('p');
  who.className = 'who';
  who.textContent = subject.parties.length
    ? subject.parties.map((party) => `${party.name} ${pct(party.share)}`).join(' · ')
    : (subject.ownerName || 'No owner');
  detailNode.append(who);
  if (subject.ownerChangedAt || subject.missingSince) {
    const flags = document.createElement('div');
    flags.className = 'flags';
    if (subject.ownerChangedAt) {
      flags.append(badge('Owner changed', 'changed'));
      const note = document.createElement('p');
      note.className = 'flag-note';
      const before = subject.previousOwnerName ? ` Before: ${subject.previousOwnerName}.` : '';
      note.textContent = `This parcel changed hands. Add a comp if you learn the price.${before} Seen ${shortDate(subject.ownerChangedAt)}.`;
      flags.append(note);
    }
    if (subject.missingSince) {
      flags.append(badge('Missing from the latest file', 'missing'));
      const note = document.createElement('p');
      note.className = 'flag-note';
      note.textContent = `The last file did not include this parcel. The record stays here. Missing since ${shortDate(subject.missingSince)}.`;
      flags.append(note);
    }
    detailNode.append(flags);
  }
  if (subject.mailingLine) {
    addLabel(detailNode, 'Mail');
    const mail = document.createElement('p');
    mail.className = 'mail';
    mail.textContent = subject.mailingLine;
    detailNode.append(mail);
  }
  addFacts(detailNode, 'Property', [
    ['Where', [subject.location, subject.locCity].filter(Boolean).join(', ')],
    ['Subdivision', subject.subdivision],
    ['Acres', acres(subject.acres)],
    ['Zoning', subject.zoning],
    ['Use', subject.propUse],
    ['Built', subject.yearBuilt || ''],
    ['Waterfront', Number(subject.waterfront) > 0 ? 'Yes' : ''],
    ['Deed', subject.deedDate || ''],
  ]);
  const saleText = subject.salePrice != null
    ? `${money(subject.salePrice)}${subject.saleYear ? ` in ${subject.saleYear}` : ''}${rateLabel(subject.salePrice, subject.acres) ? ` · ${rateLabel(subject.salePrice, subject.acres)}` : ''}`
    : '';
  const historyText = (subject.valueHistory || []).map((row) => `${row.year} ${money(row.amount)}`).join(' · ');
  const appraised = subject.appraisedValue > 0
    ? money(subject.appraisedValue)
    : (subject.appraisedValue == null && subject.totalValue > 0 ? money(subject.totalValue) : '');
  addFacts(detailNode, 'Value', [
    ['Appraised', appraised],
    ['Taxable', subject.taxableValue == null ? '' : money(subject.taxableValue)],
    ['Exemption', subject.exemption || ''],
    ['Exempt amount', subject.exemptionValue > 0 ? money(subject.exemptionValue) : ''],
    ['Per acre', rateLabel(subject.totalValue, subject.acres)],
    ['Nearby', neighborLine(subject.parcelno)],
    ['Land', subject.landValue > 0 ? money(subject.landValue) : ''],
    ['Improvements', subject.improvementValue > 0 ? money(subject.improvementValue) : ''],
    ['History', historyText],
    ['Sale', saleText],
  ]);
  addLabel(detailNode, 'Record a sale');
  detailNode.append(saleForm(subject));
  if (subject.parties.length > 1) {
    addLabel(detailNode, 'Ownership split');
    detailNode.append(shareForm(subject));
  }
  compsNode.replaceChildren();
  if (found.comps.length) {
    addLabel(compsNode, 'Similar parcels');
    compsNode.append(compTable(found.comps));
  } else {
    compsNode.textContent = 'No other parcels to compare.';
  }
  showExplain(true);
  explanationNode.textContent = '';
  focusIds = new Set([subject.parcelno, ...found.comps.map((comp) => comp.parcelno)]);
  drawVisible();
  goToParcel(subject.parcelno, { scroll: !fromMap });
  await remember('comps', parcelno);
}

function compTable(comps) {
  const table = document.createElement('table');
  table.className = 'comps';
  const head = document.createElement('tr');
  for (const label of ['Score', 'Parcel', 'Acres', 'Assessed']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    if (label === 'Score' || label === 'Acres' || label === 'Assessed') cell.className = 'num';
    head.append(cell);
  }
  table.append(head);
  for (const comp of comps) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    const score = document.createElement('td');
    score.className = 'num';
    score.textContent = comp.comp.score.toFixed(0);
    const name = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = comp.location || comp.parcelno;
    const who = document.createElement('span');
    who.className = 'fine';
    who.textContent = [comp.ownerName, comp.location ? comp.parcelno : ''].filter(Boolean).join(' · ');
    const why = document.createElement('span');
    why.className = 'fine';
    const reasons = (comp.comp.reasons || []).filter((reason) => reason !== 'within 1 km' && reason !== 'nearby');
    if (comp.comp.distanceKm != null) reasons.push(`${comp.comp.distanceKm} km`);
    why.textContent = reasons.join(' · ') || 'loose match';
    name.append(strong, who, why);
    const size = document.createElement('td');
    size.className = 'num';
    size.textContent = acres(comp.acres);
    const value = document.createElement('td');
    value.className = 'num';
    value.textContent = money(comp.totalValue);
    const rate = document.createElement('span');
    rate.className = 'fine';
    rate.textContent = rateLabel(comp.totalValue, comp.acres);
    value.append(rate);
    row.append(score, name, size, value);
    row.addEventListener('click', () => showParcel(comp.parcelno));
    table.append(row);
  }
  return table;
}

async function showOwner(ownerKey) {
  const owner = library.ownerDetail(ownerKey);
  if (!owner) return;
  selected = null;
  current = null;
  markOwner(owner.ownerKey);
  document.querySelector('#detail-title').textContent = owner.publicOwner ? `${owner.name} (public)` : owner.name;
  showPeek(owner.name, `${owner.parcelCount} ${owner.parcelCount === 1 ? 'parcel' : 'parcels'} · ${acres(owner.acres)}`);
  detailNode.replaceChildren();
  compsNode.replaceChildren();
  showExplain(false);
  if (owner.mailingLine) {
    addLabel(detailNode, 'Mail');
    const mail = document.createElement('p');
    mail.className = 'mail';
    mail.textContent = owner.mailingLine;
    detailNode.append(mail);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ghost';
    copy.textContent = 'Copy address';
    copy.addEventListener('click', async () => {
      const text = [owner.name, owner.mailingLine].filter(Boolean).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        statusNode.textContent = 'Address copied.';
      } catch {
        statusNode.textContent = text;
      }
    });
    detailNode.append(copy);
  }
  if (owner.absentee && owner.mailingCity) {
    const away = document.createElement('p');
    away.className = 'fine';
    away.textContent = owner.propertyTown
      ? `Mail goes to ${owner.mailingCity}. The land is in ${owner.propertyTown}.`
      : `Mail goes to ${owner.mailingCity}.`;
    detailNode.append(away);
  }
  addFacts(detailNode, 'Holdings', [
    ['Parcels', owner.parcelCount.toLocaleString()],
    ['Acres', acres(owner.acres)],
    ['Share of the file', pct(owner.acreShare)],
    ['Assessed', money(owner.value)],
    ['Per acre', rateLabel(owner.value, owner.acres)],
  ]);
  const form = document.createElement('form');
  form.className = 'edit';
  const status = document.createElement('select');
  status.setAttribute('aria-label', 'Contact status');
  status.append(new Option('No status', ''));
  for (const [value, label] of Object.entries(CONTACT_STATUS)) status.append(new Option(label, value));
  status.value = outreach[owner.ownerKey]?.status || '';
  const note = document.createElement('textarea');
  note.setAttribute('aria-label', 'Contact note');
  note.placeholder = 'Note';
  note.value = outreach[owner.ownerKey]?.note || '';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'ghost';
  save.textContent = 'Save contact';
  form.append(status, note, save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!status.value && !note.value.trim()) delete outreach[owner.ownerKey];
    else outreach[owner.ownerKey] = { status: status.value, note: note.value.trim() };
    await saveKey('outreach', outreach);
    renderOwners();
    await showOwner(owner.ownerKey);
  });
  addLabel(detailNode, 'Contact');
  detailNode.append(form);
  if (owner.linked.length) {
    const linked = document.createElement('p');
    linked.textContent = `Same owner as ${owner.linked.map((item) => item.name).join(', ')}`;
    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.className = 'ghost';
    unlink.textContent = 'Unlink';
    unlink.addEventListener('click', async () => {
      for (const item of owner.linked) delete links[item.key];
      library.setLinks(links);
      await saveKey('links', links);
      renderOwners();
      indexFeatures();
      drawVisible();
      await showOwner(owner.ownerKey);
    });
    detailNode.append(linked, unlink);
  }
  const linkForm = document.createElement('form');
  linkForm.className = 'edit';
  const linkInput = document.createElement('input');
  linkInput.setAttribute('aria-label', 'Same owner as');
  linkInput.placeholder = 'Same owner as';
  const linkButton = document.createElement('button');
  linkButton.type = 'submit';
  linkButton.className = 'ghost';
  linkButton.textContent = 'Link';
  const linkNote = document.createElement('span');
  linkNote.className = 'fine';
  linkForm.append(linkInput, linkButton, linkNote);
  linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const needle = linkInput.value.trim().toLowerCase();
    const owners = library.ownerReport({ limit: 10000 }).shown
      .filter((item) => item.ownerKey !== owner.ownerKey);
    const exact = owners.filter((item) => item.name.toLowerCase() === needle);
    const loose = owners.filter((item) => item.name.toLowerCase().includes(needle));
    const chosen = exact[0] || (loose.length === 1 ? loose[0] : null);
    if (!needle || !chosen) {
      linkNote.textContent = 'Type the other owner’s full name.';
      return;
    }
    links[chosen.ownerKey] = owner.ownerKey;
    if (outreach[chosen.ownerKey] && !outreach[owner.ownerKey]) outreach[owner.ownerKey] = outreach[chosen.ownerKey];
    delete outreach[chosen.ownerKey];
    library.setLinks(links);
    await saveKey('links', links);
    await saveKey('outreach', outreach);
    renderOwners();
    indexFeatures();
    drawVisible();
    await showOwner(owner.ownerKey);
  });
  addLabel(detailNode, 'Link another name');
  detailNode.append(linkForm);
  addLabel(detailNode, 'Parcels');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-scroll';
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Address', 'Acres', 'Assessed', 'Water']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    if (label === 'Acres' || label === 'Assessed') cell.className = 'num';
    head.append(cell);
  }
  table.append(head);
  for (const parcel of owner.parcelList) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    const where = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = parcel.location || `Parcel ${parcel.parcelno}`;
    const sub = document.createElement('span');
    sub.className = 'fine';
    sub.textContent = [parcel.locCity, parcel.location ? parcel.parcelno : ''].filter(Boolean).join(' · ');
    where.append(strong, sub);
    row.append(where);
    const cells = [
      acres(parcel.acres),
      money(parcel.totalValue),
      Number(parcel.waterfront) > 0 ? 'Yes' : '',
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index < 2) cell.className = 'num';
      cell.textContent = value;
      row.append(cell);
    });
    row.addEventListener('click', () => showParcel(parcel.parcelno));
    table.append(row);
  }
  wrap.append(table);
  detailNode.append(wrap);
  focusIds = new Set(owner.parcelList.map((parcel) => parcel.parcelno));
  refreshStyles();
  zoomTo(focusIds);
  detailNode.scrollIntoView({ block: 'nearest' });
}

function saleForm(subject) {
  const form = document.createElement('form');
  form.className = 'edit';
  const input = document.createElement('input');
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.placeholder = 'Sale price';
  input.setAttribute('aria-label', 'Sale price');
  input.value = subject.salePrice ?? '';
  const yearInput = document.createElement('input');
  yearInput.inputMode = 'numeric';
  yearInput.autocomplete = 'off';
  yearInput.placeholder = 'Sale year';
  yearInput.setAttribute('aria-label', 'Sale year');
  yearInput.value = subject.saleYear ?? '';
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'ghost';
  button.textContent = 'Save sale';
  const note = document.createElement('span');
  note.className = 'fine';
  form.append(input, yearInput, button, note);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = input.value.trim().replace(/[$,]/g, '');
    const yearRaw = yearInput.value.trim();
    if (raw !== '' && !Number.isFinite(Number(raw))) {
      note.textContent = 'Enter a sale price, or leave it blank to clear it.';
      return;
    }
    const year = yearRaw === '' ? null : Number(yearRaw);
    if (year != null && (!Number.isInteger(year) || year < 1800 || year > 2100)) {
      note.textContent = 'Enter a sale year, or leave it blank.';
      return;
    }
    const sale = raw === '' || Number(raw) === 0 ? null : Number(raw);
    library.update(subject.parcelno, { sale_price: sale, sale_year: sale == null ? null : year });
    await saveKey('parcels', library.parcels);
    await saveEdits();
    renderOwners();
    await showParcel(subject.parcelno);
  });
  return form;
}

function shareForm(subject) {
  const form = document.createElement('form');
  form.className = 'edit';
  const inputs = subject.parties.map((party) => {
    const label = document.createElement('label');
    label.append(document.createTextNode(party.name));
    const input = document.createElement('input');
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `${party.name} percent`);
    const percent = Math.round(party.share * 1000) / 10;
    input.value = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
    label.append(input);
    form.append(label);
    return { key: party.key, input };
  });
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'ghost';
  button.textContent = 'Save shares';
  const note = document.createElement('span');
  note.className = 'fine';
  form.append(button, note);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const shares = {};
    let total = 0;
    for (const row of inputs) {
      const percent = Number(row.input.value);
      if (!Number.isFinite(percent) || percent < 0) {
        note.textContent = 'Shares need to add up to 100.';
        return;
      }
      shares[row.key] = percent / 100;
      total += percent;
    }
    if (Math.abs(total - 100) >= 2) {
      note.textContent = 'Shares need to add up to 100.';
      return;
    }
    library.update(subject.parcelno, { shares });
    await saveKey('parcels', library.parcels);
    await saveEdits();
    paintColors();
    indexFeatures();
    drawVisible();
    renderOwners();
    await showParcel(subject.parcelno);
  });
  return form;
}

function collectEdits() {
  const out = {};
  for (const parcel of library.parcels) {
    if (parcel.sale_price == null && !parcel.shares) continue;
    out[parcel.parcelno] = { sale_price: parcel.sale_price ?? null, sale_year: parcel.sale_year ?? null, shares: parcel.shares || null };
  }
  return out;
}

async function saveEdits() {
  edits = collectEdits();
  await saveKey('edits', edits);
}

// The shared copy wins, so a sale cleared on one device clears everywhere.
function applyEdits() {
  if (!editsShared) return;
  for (const parcel of library.parcels) {
    const edit = edits[parcel.parcelno];
    library.update(parcel.parcelno, {
      sale_price: edit?.sale_price ?? null,
      sale_year: edit?.sale_year ?? null,
      shares: edit?.shares || undefined,
    });
  }
}

function applyRecords(records, { asImport = false } = {}) {
  if (library.parcels.length) {
    const result = library.replace(records);
    if (asImport) changes = result.changes;
  } else {
    library = createLibrary(records);
    library.setLinks(links);
    if (asImport) changes = { gained: [], lost: [] };
  }
}

function showLoaded() {
  refreshNeighbors();
  showWorkspace(library.parcels.length > 0);
  if (!library.parcels.length) return;
  showMap();
  renderOwners();
  renderSearches();
  renderChanges();
}

async function fetchServerRecords() {
  const res = await fetch('/api/parcels/geometry', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('The server did not send the parcels.');
  return recordsFromText(await res.text(), 'server.geojson');
}

// A browser that loaded parcels before the server had a database sends its copy up.
async function uploadSavedParcels() {
  statusNode.textContent = `Sending the ${library.parcels.length.toLocaleString()} parcels saved in this browser to the server…`;
  const blob = new Blob([JSON.stringify(featuresFromParcels(library.parcels))], { type: 'application/geo+json' });
  const form = new FormData();
  form.append('file', blob, 'saved-in-browser.geojson');
  const res = await fetch('/api/imports', { method: 'POST', body: form, credentials: 'same-origin' });
  const summary = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(summary.message || 'The server did not take the saved parcels.');
  if (summary.importId != null) knownImportId = summary.importId;
  await saveEdits();
  return summary;
}

async function loadFromServer() {
  statusNode.textContent = 'Loading parcels from the server…';
  try {
    let records = await fetchServerRecords();
    if (!records.length && library.parcels.length) {
      const summary = await uploadSavedParcels();
      records = await fetchServerRecords();
      showToast(`${summary.message || 'Saved to the server.'} Every device now sees them.`);
    }
    serverParcels = records.length;
    if (!records.length) {
      statusNode.textContent = '';
      showEmptyText();
      showLoaded();
      return;
    }
    applyRecords(records);
    applyEdits();
    await saveLocal('parcels', library.parcels);
    showLoaded();
    statusNode.textContent = '';
  } catch (error) {
    statusNode.textContent = `${error.message} The copy saved in this browser is still here.`;
  }
  showSyncNote();
}

async function checkServer() {
  try {
    const res = await fetch('/api/server', { credentials: 'same-origin' });
    if (res.ok && (await res.json()).database) return 'in';
  } catch {
    // Offline or no server: the page works from this browser's copy.
  }
  return 'off';
}

async function useFile(file) {
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  if (key === pendingFileKey) return;
  pendingFileKey = key;
  const token = ++importToken;
  statusNode.textContent = `Reading ${file.name}…`;
  try {
    const text = await file.text();
    if (token !== importToken) return;
    const records = recordsFromText(text, file.name);
    if (!records.length) {
      statusNode.textContent = `${file.name} has no parcels.`;
      if (pendingFileKey === key) pendingFileKey = '';
      return;
    }
    if (serverMode === 'in') {
      if (/\.csv$/i.test(file.name)) {
        statusNode.textContent = 'The server saves the .geojson file. Drop that one to keep it for every browser.';
        if (pendingFileKey === key) pendingFileKey = '';
        return;
      }
      statusNode.textContent = `Saving ${file.name} to the server…`;
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/api/imports', { method: 'POST', body: form, credentials: 'same-origin' });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(summary.message || 'The server did not save it.');
      if (token !== importToken) return;
      const saved = await fetchServerRecords();
      if (!saved) return;
      applyRecords(saved, { asImport: true });
      applyEdits();
      serverParcels = saved.length;
      if (summary.importId != null) knownImportId = summary.importId;
      showToast(summary.message || 'Saved to the server. Every device now sees this file.');
    } else {
      applyRecords(records, { asImport: true });
    }
    await saveKey('parcels', library.parcels);
    await saveKey('changes', changes);
    if (token !== importToken) return;
    selected = null;
    current = null;
    openOwnerKey = '';
    focusIds = new Set();
    detailNode.textContent = 'Click a parcel on the map, or an owner in the list.';
    compsNode.replaceChildren();
    showExplain(false);
    resultsNode.textContent = '';
    document.querySelector('#results-title').hidden = true;
    refreshNeighbors();
    showWorkspace(true);
    showMap();
    renderOwners();
    renderChanges();
    await saveBuyBox();
    statusNode.textContent = '';
    fileInput.value = '';
  } catch (error) {
    if (token === importToken) {
      statusNode.textContent = `${file.name} could not be read. ${error.message}`;
      if (pendingFileKey === key) pendingFileKey = '';
    }
  }
}

function showEmptyText() {
  document.querySelector('#empty-lede').innerHTML = serverMode === 'in'
    ? 'The server has no parcels yet. Drop the <strong>.geojson</strong> from the extension here, or open this site on the computer that already shows them. The server keeps them, so every device sees the same parcels.'
    : 'Drop the <strong>.geojson</strong> from the extension. This site has no database yet, so only this browser keeps the file and other devices start empty. Add a PostgreSQL database to the Railway service so every device shares it.';
}

document.querySelector('#drop').addEventListener('click', () => fileInput.click());
replaceNode.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) useFile(file);
});

drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('dragging');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) useFile(file);
});

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  searchParcels(document.querySelector('#q').value);
});
for (const id of ['private', 'absentee', 'condos', 'below', 'waterfront', 'zoning', 'min-acres', 'max-acre']) {
  document.querySelector(`#${id}`).addEventListener('change', applyBuyBox);
}
document.querySelector('#draw').addEventListener('click', () => {
  if (area) {
    clearDrawnArea();
    statusNode.textContent = '';
    applyBuyBox();
    return;
  }
  if (drawMode) {
    drawMode = false;
    dragStart = null;
    if (draftLayer && map) {
      map.removeLayer(draftLayer);
      draftLayer = null;
    }
    if (map) map.dragging.enable();
    syncDrawButton();
    statusNode.textContent = '';
    return;
  }
  beginDraw();
});
document.querySelector('#labels').addEventListener('click', () => {
  const source = boxActive() ? matchedLibrary() : library;
  const owners = source.ownerReport({ privateOnly: false, limit: 10000 }).shown;
  if (!owners.length) {
    statusNode.textContent = 'No owners match the buy box.';
    return;
  }
  const lines = [[
    'Name', 'Street', 'City', 'State', 'Zip', 'Parcels', 'Acres', 'Assessed', 'Waterfront', 'Absentee',
  ].join(',')];
  for (const owner of owners) {
    const detail = source.ownerDetail(owner.ownerKey);
    lines.push([
      owner.name,
      detail?.mailingStreet || '',
      detail?.mailingCity || '',
      detail?.mailingState || '',
      detail?.mailingZip || '',
      owner.parcelCount,
      owner.acres == null ? '' : Number(owner.acres).toFixed(2),
      owner.value == null ? '' : Math.round(owner.value),
      detail?.parcelList.some((parcel) => Number(parcel.waterfront) > 0) ? 'Yes' : '',
      detail?.absentee ? 'Yes' : '',
    ].map(csvCell).join(','));
  }
  downloadCsv('ketchikan-labels.csv', lines);
  statusNode.textContent = '';
});
document.querySelector('#export').addEventListener('click', () => {
  const rows = library.ownerReport({ limit: 10000 }).shown
    .map((owner) => ({ owner, contact: outreach[owner.ownerKey] }))
    .filter((row) => row.contact?.status);
  if (!rows.length) {
    statusNode.textContent = 'Mark an owner to build the contact list.';
    return;
  }
  const lines = [[
    'Name', 'Street', 'City', 'State', 'Zip', 'Mailing', 'Status', 'Note', 'Parcels', 'Acres', 'Assessed',
  ].join(',')];
  for (const row of rows) {
    const detail = library.ownerDetail(row.owner.ownerKey);
    lines.push([
      row.owner.name,
      detail?.mailingStreet || '',
      detail?.mailingCity || '',
      detail?.mailingState || '',
      detail?.mailingZip || '',
      detail?.mailingLine || '',
      CONTACT_STATUS[row.contact.status] || '',
      row.contact.note || '',
      detail?.parcelList.map((parcel) => parcel.parcelno).join(' ') || '',
      row.owner.acres == null ? '' : Number(row.owner.acres).toFixed(2),
      row.owner.value == null ? '' : Math.round(row.owner.value),
    ].map(csvCell).join(','));
  }
  downloadCsv('ketchikan-contacts.csv', lines);
  statusNode.textContent = '';
});
document.querySelector('#clear').addEventListener('click', async () => {
  library = createLibrary();
  searches = [];
  changes = { gained: [], lost: [] };
  outreach = {};
  links = {};
  selected = null;
  current = null;
  openOwnerKey = '';
  await saveKey('parcels', []);
  await saveKey('searches', []);
  await saveKey('changes', changes);
  await saveKey('outreach', outreach);
  await saveKey('links', links);
  neighborMap = new Map();
  clearDrawnArea();
  savedZoning = '';
  document.querySelector('#detail-title').textContent = 'Parcel';
  document.querySelector('#map-legend').hidden = true;
  document.querySelector('#zoning').replaceChildren(new Option('All zoning', ''));
  document.querySelector('#max-acre').value = '';
  document.querySelector('#min-acres').value = '';
  document.querySelector('#private').checked = false;
  document.querySelector('#absentee').checked = false;
  document.querySelector('#condos').checked = false;
  document.querySelector('#below').checked = false;
  document.querySelector('#waterfront').checked = false;
  await saveKey('buybox', {
    privateOnly: false,
    absentee: false,
    skipCondos: false,
    below: false,
    waterfront: false,
    zoning: '',
    minAcres: '',
    maxAcre: '',
    area: null,
  });
  ownersNode.replaceChildren();
  resultsNode.replaceChildren();
  document.querySelector('#results-title').hidden = true;
  searchesNode.replaceChildren();
  detailNode.textContent = 'Click a parcel on the map, or an owner in the list.';
  peekNode.hidden = true;
  renderChanges();
  compsNode.replaceChildren();
  mapNode.hidden = true;
  document.querySelector('#map-note').hidden = true;
  if (map) {
    map.remove();
    map = null;
    parcelLayer = null;
  }
  focusIds = new Set();
  showExplain(false);
  showWorkspace(false);
});
askInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    explainButton.click();
  }
});
explainButton.addEventListener('click', async () => {
  if (!current) return;
  explanationNode.textContent = 'Comparing…';
  explainButton.disabled = true;
  try {
    const slim = ({ geometry, ...parcel }) => parcel;
    const subject = slim(current.subject);
    const bench = neighborMap.get(subject.parcelno);
    if (bench) subject.neighbor = { rate: bench.rate, median: bench.median, below: bench.below };
    const body = await postJson('/api/explain', {
      subject,
      comps: current.comps.map(slim),
      question: askInput.value.trim(),
    });
    renderAnswer(explanationNode, body.text || 'No comparison came back.', body.lookups);
  } catch {
    explanationNode.textContent = 'The comparison did not finish. The ranked comps are still on this page.';
  } finally {
    explainButton.disabled = false;
  }
});

askAllInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    askAllButton.click();
  }
});
askAllButton.addEventListener('click', async () => {
  const question = askAllInput.value.trim();
  if (!question) {
    askAllInput.focus();
    return;
  }
  askAllAnswer.textContent = 'Looking through the parcels…';
  askAllButton.disabled = true;
  try {
    const body = await postJson('/api/ask', { question, parcel: selected || undefined });
    renderAnswer(askAllAnswer, body.text || 'No answer came back.', body.lookups);
  } catch {
    askAllAnswer.textContent = 'The question did not finish. Try again.';
  } finally {
    askAllButton.disabled = false;
  }
});

async function checkAi() {
  try {
    const res = await fetch('/api/ai');
    return res.ok && Boolean((await res.json()).available);
  } catch {
    return false;
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename, lines) {
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function setBuyBox(buybox = {}) {
  document.querySelector('#private').checked = Boolean(buybox.privateOnly);
  document.querySelector('#absentee').checked = Boolean(buybox.absentee);
  document.querySelector('#condos').checked = Boolean(buybox.skipCondos);
  document.querySelector('#below').checked = Boolean(buybox.below);
  document.querySelector('#waterfront').checked = Boolean(buybox.waterfront);
  document.querySelector('#min-acres').value = buybox.minAcres || '';
  document.querySelector('#max-acre').value = buybox.maxAcre || '';
  savedZoning = buybox.zoning || '';
  const box = buybox.area;
  area = box && [box.south, box.west, box.north, box.east].every((value) => Number.isFinite(Number(value)))
    ? { south: Number(box.south), west: Number(box.west), north: Number(box.north), east: Number(box.east) }
    : null;
  syncDrawButton();
}

function hasContent(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function showSyncNote() {
  const note = document.querySelector('#sync-note');
  const synced = serverMode === 'in' && serverParcels > 0;
  note.hidden = workspaceNode.hidden;
  note.classList.toggle('is-shared', synced);
  if (synced) {
    note.textContent = `Synced. Every device that opens this site sees these ${serverParcels.toLocaleString()} parcels, contacts, notes, and sales.`;
  } else if (serverMode === 'in') {
    note.textContent = 'These parcels have not reached the server yet. Drop the .geojson again on this device and every device will see them.';
  } else {
    note.textContent = 'These parcels are only in this browser. This site has no database, so other devices start empty. Add a PostgreSQL database to the Railway service and redeploy.';
  }
}

// Another device may have imported a file or saved a note; pull both in.
async function syncFromServer() {
  if (serverMode !== 'in' || syncing || document.hidden) return;
  syncing = true;
  try {
    const next = await fetchShared();
    const values = next.values || {};
    const same = (key, current) => JSON.stringify(values[key] ?? null) === JSON.stringify(current ?? null);
    let redraw = false;
    if (Object.hasOwn(values, 'outreach') && !same('outreach', outreach)) {
      outreach = values.outreach || {};
      redraw = true;
    }
    if (Object.hasOwn(values, 'links') && !same('links', links)) {
      links = values.links || {};
      library.setLinks(links);
      redraw = true;
    }
    if (Object.hasOwn(values, 'buybox') && document.activeElement?.closest?.('#search-form') == null) {
      const current = await loadKey('buybox');
      if (!same('buybox', current)) {
        setBuyBox(values.buybox || {});
        showArea();
        redraw = true;
      }
    }
    if (Object.hasOwn(values, 'searches') && !same('searches', searches)) {
      searches = values.searches || [];
      renderSearches();
    }
    if (Object.hasOwn(values, 'changes') && !same('changes', changes)) {
      changes = values.changes || { gained: [], lost: [] };
      renderChanges();
    }
    if (Object.hasOwn(values, 'edits') && !same('edits', edits)) {
      edits = values.edits || {};
      editsShared = true;
      applyEdits();
      redraw = true;
    }
    for (const key of Object.keys(values)) await saveLocal(key, values[key]);
    if (next.importId !== knownImportId) {
      knownImportId = next.importId;
      await loadFromServer();
    } else if (redraw && library.parcels.length) {
      paintColors();
      renderOwners();
      indexFeatures();
      if (map) drawVisible();
    }
  } catch {
    // Offline for now; the next check tries again.
  } finally {
    syncing = false;
  }
}

serverMode = await checkServer();
let remote = null;
if (serverMode === 'in') {
  try {
    remote = await fetchShared();
  } catch {
    remote = null;
  }
  shareWithServer(Boolean(remote), {
    onError: () => showToast('This change is saved in this browser. The server did not take it, so other devices will see it after the next change.'),
  });
}

async function startKey(key) {
  const local = await loadKey(key);
  if (!remote) return local;
  if (Object.hasOwn(remote.values || {}, key)) {
    await saveLocal(key, remote.values[key]);
    return remote.values[key];
  }
  // The first device to connect shares what it already saved.
  if (hasContent(local)) await pushShared(key, local).catch(() => {});
  return local;
}

const savedParcels = await loadKey('parcels');
searches = (await startKey('searches')) || [];
changes = (await startKey('changes')) || { gained: [], lost: [] };
outreach = (await startKey('outreach')) || {};
links = (await startKey('links')) || {};
setBuyBox((await startKey('buybox')) || {});
if (remote && Object.hasOwn(remote.values || {}, 'edits')) {
  edits = remote.values.edits || {};
  editsShared = true;
}
knownImportId = remote?.importId ?? null;
aiReady = serverMode === 'in' && await checkAi();
showEmptyText();
if (Array.isArray(savedParcels) && savedParcels.length) {
  library = createLibrary(savedParcels);
  library.setLinks(links);
  applyEdits();
  showLoaded();
} else {
  showWorkspace(false);
}
if (serverMode === 'in') await loadFromServer();
if (remote && !editsShared) {
  editsShared = true;
  edits = collectEdits();
  if (hasContent(edits)) await pushShared('edits', edits).catch(() => {});
}
showSyncNote();
if (serverMode === 'in') {
  setInterval(syncFromServer, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncFromServer();
  });
}
