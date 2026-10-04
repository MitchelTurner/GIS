import { createLibrary, recordsFromText } from '/lib/library.js';
import { OWNER_COLORS, parties, perAcre } from '/lib/ownership.js';
import { loadKey, saveKey } from './persist.js';

const emptyNode = document.querySelector('#empty');
const workspaceNode = document.querySelector('#workspace');
const replaceNode = document.querySelector('#replace');
const ownersNode = document.querySelector('#owners');
const resultsNode = document.querySelector('#results');
const detailNode = document.querySelector('#detail');
const compsNode = document.querySelector('#comps');
const mapNode = document.querySelector('#map');
const explainButton = document.querySelector('#explain');
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
  document.querySelector('#clear').hidden = !hasParcels;
  document.querySelector('#export').hidden = !hasParcels;
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

function markOwner(key) {
  openOwnerKey = key || '';
  for (const row of ownersNode.querySelectorAll('tr[data-owner]')) {
    row.classList.toggle('is-on', row.dataset.owner === openOwnerKey);
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

function parcelPasses(parcel) {
  if (document.querySelector('#private').checked && primaryParty(parcel)?.publicOwner) return false;
  const zoning = document.querySelector('#zoning').value;
  if (zoning && String(parcel.zoning || '') !== zoning) return false;
  const max = Number(String(document.querySelector('#max-acre').value || '').replace(/[$,]/g, ''));
  if (Number.isFinite(max) && max > 0) {
    const rate = perAcre(parcel.total_value, parcel.acres);
    if (rate == null || rate > max) return false;
  }
  return true;
}

function fillZoning() {
  const select = document.querySelector('#zoning');
  const current = select.value;
  const zones = [...new Set(library.parcels.map((parcel) => parcel.zoning).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  select.replaceChildren(new Option('All zoning', ''));
  for (const zone of zones) select.append(new Option(zone, zone));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderOwners() {
  paintColors();
  fillZoning();
  const everyone = library.ownerReport({ privateOnly: false, limit: 1 });
  const report = library.ownerReport({ privateOnly: document.querySelector('#private').checked, limit: 40 });
  const missingValue = !library.parcels.some((parcel) => Number(parcel.total_value) > 0);
  const stats = statStrip([
    ['Parcels', everyone.parcels.toLocaleString()],
    ['Acres', everyone.acres.toFixed(1)],
    ['Owners', everyone.owners.toLocaleString()],
    ['Assessed', everyone.value ? money(everyone.value) : '—'],
  ]);
  const caption = document.createElement('p');
  caption.className = 'fine';
  const shown = report.shown.length;
  const listNote = report.owners > shown ? `Showing the ${shown} largest. ` : '';
  caption.textContent = `${listNote}Acres is that owner's share of the file. Click a name for the mailing address.`;
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Owner', 'Acres', 'Assessed']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    if (label !== 'Owner') cell.className = 'num';
    head.append(cell);
  }
  table.append(head);
  for (const owner of report.shown) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    row.dataset.owner = owner.ownerKey;
    const name = document.createElement('td');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = ownerColorMap.get(owner.ownerKey) || '#8d8478';
    const strong = document.createElement('strong');
    strong.textContent = owner.publicOwner ? `${owner.name} (public)` : owner.name;
    const meta = document.createElement('span');
    meta.className = 'fine';
    const bits = [`${owner.parcelCount} ${owner.parcelCount === 1 ? 'parcel' : 'parcels'}`];
    if (outreach[owner.ownerKey]?.status) bits.push(CONTACT_STATUS[outreach[owner.ownerKey].status]);
    meta.textContent = bits.join(' · ');
    name.append(swatch, strong, meta);
    const land = document.createElement('td');
    land.className = 'num';
    land.textContent = acres(owner.acres);
    const share = document.createElement('span');
    share.className = 'fine';
    share.textContent = `${pct(owner.acreShare)} of the file`;
    land.append(share);
    const value = document.createElement('td');
    value.className = 'num';
    value.textContent = money(owner.value);
    const per = document.createElement('span');
    per.className = 'fine';
    per.textContent = rateLabel(owner.value, owner.acres);
    value.append(per);
    row.append(name, land, value);
    row.addEventListener('click', () => showOwner(owner.ownerKey));
    table.append(row);
  }
  const nodes = [stats, caption, table];
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

function renderSearches() {
  document.querySelector('#recent-title').hidden = searches.length === 0;
  searchesNode.replaceChildren();
  for (const search of searches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = search.query;
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
  for (const label of ['Parcel', 'Owner', 'Where', 'Acres', 'Assessed']) {
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
      row.parcelno,
      row.owner_name || '',
      [row.location, row.loc_city].filter(Boolean).join(', '),
      acres(row.acres),
      money(row.total_value),
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index >= 3) cell.className = 'num';
      cell.textContent = value;
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

function styleFor(feature) {
  const fill = ownerColorMap.get(feature.properties.ownerKey) || '#8d8478';
  const id = feature.properties.parcelno;
  if (id === selected) return { color: '#fffaf3', weight: 3, fillColor: fill, fillOpacity: 0.85 };
  if (focusIds.has(id)) return { color: '#fffaf3', weight: 2.5, fillColor: fill, fillOpacity: 0.7 };
  return { color: '#fffaf3', weight: 1.2, fillColor: fill, fillOpacity: 0.55 };
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
    return parcel && parcelPasses(parcel) && intersects(feature.bbox, view);
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
      ].filter(Boolean).join(' · ');
      layer.bindTooltip(tip, { sticky: true });
      layer.on('click', () => showParcel(feature.properties.parcelno));
    },
  }).addTo(map);
  mapNode.dataset.shown = String(visible.length);
  const legend = document.querySelector('#map-legend');
  if (!mapNode.hidden) {
    legend.hidden = false;
    legend.textContent = `${visible.length.toLocaleString()} parcels in this view. Each color is one of the largest owners. Zoning and max $/acre filter the map. Private owners hides public land in the list too.`;
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
    drawVisible();
  };
  requestAnimationFrame(place);
  setTimeout(place, 250);
}

async function showParcel(parcelno) {
  const found = library.comps(parcelno);
  if (!found) {
    detailNode.textContent = 'That parcel is not in the saved file.';
    compsNode.replaceChildren();
    explainButton.hidden = true;
    return;
  }
  selected = parcelno;
  current = found;
  markOwner('');
  const subject = found.subject;
  document.querySelector('#detail-title').textContent = subject.parcelno;
  detailNode.replaceChildren();
  const who = document.createElement('p');
  who.className = 'who';
  who.textContent = subject.parties.length
    ? subject.parties.map((party) => `${party.name} ${pct(party.share)}`).join(' · ')
    : (subject.ownerName || 'No owner');
  detailNode.append(who);
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
  ]);
  const saleText = subject.salePrice != null
    ? `${money(subject.salePrice)}${subject.saleYear ? ` in ${subject.saleYear}` : ''}${rateLabel(subject.salePrice, subject.acres) ? ` · ${rateLabel(subject.salePrice, subject.acres)}` : ''}`
    : '';
  addFacts(detailNode, 'Value', [
    ['Assessed', subject.totalValue > 0 ? money(subject.totalValue) : ''],
    ['Per acre', rateLabel(subject.totalValue, subject.acres)],
    ['Land', subject.landValue > 0 ? money(subject.landValue) : ''],
    ['Improvements', subject.improvementValue > 0 ? money(subject.improvementValue) : ''],
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
  explainButton.hidden = false;
  explanationNode.textContent = '';
  focusIds = new Set([subject.parcelno, ...found.comps.map((comp) => comp.parcelno)]);
  refreshStyles();
  zoomTo(focusIds);
  detailNode.scrollIntoView({ block: 'nearest' });
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
    strong.textContent = comp.parcelno;
    const who = document.createElement('span');
    who.className = 'fine';
    who.textContent = comp.ownerName || '';
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
  detailNode.replaceChildren();
  compsNode.replaceChildren();
  explainButton.hidden = true;
  explanationNode.textContent = '';
  if (owner.mailingLine) {
    addLabel(detailNode, 'Mail');
    const mail = document.createElement('p');
    mail.className = 'mail';
    mail.textContent = owner.mailingLine;
    detailNode.append(mail);
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
  for (const label of ['Parcel', 'Where', 'Acres', 'Assessed']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    if (label === 'Acres' || label === 'Assessed') cell.className = 'num';
    head.append(cell);
  }
  table.append(head);
  for (const parcel of owner.parcelList) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    const cells = [
      parcel.parcelno,
      [parcel.location, parcel.locCity].filter(Boolean).join(', '),
      acres(parcel.acres),
      money(parcel.totalValue),
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index >= 2) cell.className = 'num';
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
    paintColors();
    indexFeatures();
    drawVisible();
    renderOwners();
    await showParcel(subject.parcelno);
  });
  return form;
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
    if (library.parcels.length) {
      const result = library.replace(records);
      changes = result.changes;
    } else {
      library = createLibrary(records);
      library.setLinks(links);
      changes = { gained: [], lost: [] };
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
    explainButton.hidden = true;
    explanationNode.textContent = '';
    resultsNode.textContent = '';
    document.querySelector('#results-title').hidden = true;
    showWorkspace(true);
    showMap();
    renderOwners();
    renderChanges();
    statusNode.textContent = '';
    fileInput.value = '';
  } catch (error) {
    if (token === importToken) {
      statusNode.textContent = `${file.name} could not be read. ${error.message}`;
      if (pendingFileKey === key) pendingFileKey = '';
    }
  }
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
document.querySelector('#private').addEventListener('change', () => {
  renderOwners();
  if (map) drawVisible();
});
document.querySelector('#zoning').addEventListener('change', () => {
  if (map) drawVisible();
});
document.querySelector('#max-acre').addEventListener('change', () => {
  if (map) drawVisible();
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
    'Name', 'Mailing', 'Status', 'Note', 'Parcels', 'Acres', 'Assessed',
  ].join(',')];
  for (const row of rows) {
    const detail = library.ownerDetail(row.owner.ownerKey);
    lines.push([
      row.owner.name,
      detail?.mailingLine || '',
      CONTACT_STATUS[row.contact.status] || '',
      row.contact.note || '',
      detail?.parcelList.map((parcel) => parcel.parcelno).join(' ') || '',
      row.owner.acres == null ? '' : Number(row.owner.acres).toFixed(2),
      row.owner.value == null ? '' : Math.round(row.owner.value),
    ].map(csvCell).join(','));
  }
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'ketchikan-contacts.csv';
  link.click();
  URL.revokeObjectURL(link.href);
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
  document.querySelector('#detail-title').textContent = 'Parcel';
  document.querySelector('#map-legend').hidden = true;
  document.querySelector('#zoning').replaceChildren(new Option('All zoning', ''));
  document.querySelector('#max-acre').value = '';
  document.querySelector('#private').checked = false;
  ownersNode.replaceChildren();
  resultsNode.replaceChildren();
  document.querySelector('#results-title').hidden = true;
  searchesNode.replaceChildren();
  detailNode.textContent = 'Click a parcel on the map, or an owner in the list.';
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
  explainButton.hidden = true;
  explanationNode.textContent = '';
  showWorkspace(false);
});
explainButton.addEventListener('click', async () => {
  if (!current) return;
  explanationNode.textContent = 'Comparing…';
  try {
    const slim = ({ geometry, ...parcel }) => parcel;
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: slim(current.subject),
        comps: current.comps.map(slim),
      }),
    });
    const body = await res.json();
    explanationNode.textContent = body.text || body.error || 'No comparison came back.';
  } catch {
    explanationNode.textContent = 'The comparison did not finish. The ranked comps are still on this page.';
  }
});

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const savedParcels = await loadKey('parcels');
searches = (await loadKey('searches')) || [];
changes = (await loadKey('changes')) || { gained: [], lost: [] };
outreach = (await loadKey('outreach')) || {};
links = (await loadKey('links')) || {};
if (Array.isArray(savedParcels) && savedParcels.length) {
  library = createLibrary(savedParcels);
  library.setLinks(links);
  showWorkspace(true);
  showMap();
  renderOwners();
  renderSearches();
  renderChanges();
}
