import { classifyArcGisUrl, isBasemapUrl, KETCHIKAN_OWNERS_URL } from './lib/arcgis.js';

const manifestVersion = globalThis.chrome?.runtime?.getManifest?.()?.version;
if (manifestVersion) document.querySelector('#version').textContent = `v${manifestVersion}`;

const detectedSection = document.querySelector('#detected');
const detectedList = document.querySelector('#detected-list');
const recentSection = document.querySelector('#recent');
const recentList = document.querySelector('#recent-list');
const status = document.querySelector('#status');
const form = document.querySelector('#manual');
const urlInput = document.querySelector('#url');

function setStatus(message) {
  status.hidden = !message;
  status.textContent = message || '';
}

function shortPath(url) {
  return new URL(url).pathname.replace(/.*\/rest\/services\//i, '');
}

function choiceButton(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'choice';
  const title = document.createElement('strong');
  title.textContent = shortPath(item.url);
  const host = document.createElement('span');
  host.textContent = `${item.kind === 'layer' ? 'Layer' : 'Service'} · ${new URL(item.url).host}`;
  button.append(title, host);
  button.addEventListener('click', () => openExtract(item.url));
  return button;
}

async function remember(url) {
  const stored = await chrome.storage.local.get({ recent: [] });
  const recent = [url, ...stored.recent.filter((item) => item !== url)].slice(0, 6);
  await chrome.storage.local.set({ recent });
}

async function openExtract(raw) {
  const item = classifyArcGisUrl(raw);
  if (!item) {
    setStatus('Use a URL that ends in MapServer, FeatureServer, or a layer number.');
    return;
  }
  await remember(item.url);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`extract.html?url=${encodeURIComponent(item.url)}`),
  });
  window.close();
}

async function collectPageUrls() {
  const found = [];
  const add = (value) => {
    if (typeof value === 'string' && value) found.push(value);
  };
  const addText = (text) => {
    if (!text) return;
    const matches = String(text).match(/https?:\/\/[^"'\\\s<>]+\/rest\/services\/[^"'\\\s<>]+/gi) || [];
    for (const match of matches) add(match.replace(/[),.;]+$/, ''));
  };
  add(location.href);
  try {
    for (const entry of performance.getEntriesByType('resource')) add(entry.name);
  } catch { /* the buffer can be unavailable in a restricted frame */ }
  for (const el of document.querySelectorAll('a[href], iframe[src], script[src]')) add(el.href || el.src);
  addText(document.documentElement?.innerHTML);

  const seen = new Set();
  const walk = (value, depth) => {
    if (!value || depth > 5 || typeof value !== 'object' || seen.has(value) || seen.size > 400) return;
    seen.add(value);
    try {
      add(value.url);
      add(value.href);
    } catch { return; }
    for (const key of ['map', 'layers', 'allLayers', 'items', 'operationalLayers', 'layer']) {
      let child;
      try { child = value[key]; } catch { continue; }
      if (!child) continue;
      if (typeof child.forEach === 'function') {
        try { child.forEach((item) => walk(item, depth + 1)); } catch { /* a layer list can throw while loading */ }
      } else {
        walk(child, depth + 1);
      }
    }
  };
  for (const key of Object.keys(window)) {
    if (!/map|view|esri|app|config|jimu/i.test(key)) continue;
    try { walk(window[key], 0); } catch { /* some globals are not readable */ }
  }

  const configs = ['config.json', 'configs/config.json', 'config/config.json'];
  await Promise.all(configs.map(async (path) => {
    try {
      const response = await Promise.race([
        fetch(new URL(path, location.href), { credentials: 'omit' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200)),
      ]);
      if (response.ok) addText(await response.text());
    } catch { /* this viewer may not publish that config */ }
  }));
  return found;
}

async function urlsOnThisTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) return [];
  const target = { tabId: tab.id };
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { ...target, allFrames: true }, func: collectPageUrls });
  } catch {
    try {
      frames = await chrome.scripting.executeScript({ target, func: collectPageUrls });
    } catch {
      setStatus('This page can’t be read. Paste the service URL instead.');
      return [];
    }
  }
  const unique = new Map();
  for (const frame of frames) {
    for (const raw of frame.result || []) {
      const item = classifyArcGisUrl(raw);
      if (item) unique.set(item.url, item);
    }
  }
  return [...unique.values()].filter((item) => !isBasemapUrl(item.url) && item.url !== KETCHIKAN_OWNERS_URL).sort((a, b) => {
    const score = (url) => {
      if (/parcel/i.test(url) && !/lotpoly|lot_number/i.test(url)) return 0;
      if (/tax|cadastr/i.test(url)) return 1;
      if (/lot/i.test(url)) return 2;
      return 3;
    };
    return score(a.url) - score(b.url) || a.url.localeCompare(b.url);
  }).slice(0, 8);
}

document.querySelector('#owners').addEventListener('click', () => openExtract(KETCHIKAN_OWNERS_URL));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  openExtract(urlInput.value.trim());
});

const detected = await urlsOnThisTab();
if (detected.length) {
  detectedSection.hidden = false;
  for (const item of detected) detectedList.append(choiceButton(item));
} else if (status.hidden) {
  setStatus('World Imagery is the basemap, not the parcels. Use Owners and mailing.');
}

const stored = await chrome.storage.local.get({ recent: [] });
for (const url of stored.recent) {
  const item = classifyArcGisUrl(url);
  if (item && !isBasemapUrl(item.url) && item.url !== KETCHIKAN_OWNERS_URL) recentList.append(choiceButton(item));
}
recentSection.hidden = recentList.childElementCount === 0;
