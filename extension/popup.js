import { classifyArcGisUrl } from './lib/arcgis.js';

document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;

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

function collectPageUrls() {
  const found = [];
  const add = (value) => {
    if (value) found.push(String(value));
  };
  add(location.href);
  for (const entry of performance.getEntriesByType('resource')) add(entry.name);
  for (const el of document.querySelectorAll('a[href], iframe[src], script[src]')) {
    add(el.href || el.src);
  }
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
  return [...unique.values()].sort((a, b) => {
    const score = (url) => (/parcel|tax|lot|cadastr/i.test(url) ? 0 : 1);
    return score(a.url) - score(b.url) || a.url.localeCompare(b.url);
  }).slice(0, 8);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  openExtract(urlInput.value.trim());
});

const detected = await urlsOnThisTab();
if (detected.length) {
  detectedSection.hidden = false;
  for (const item of detected) detectedList.append(choiceButton(item));
} else if (status.hidden) {
  setStatus('Pan the GIS map, then open this again. Or paste the service URL.');
}

const stored = await chrome.storage.local.get({ recent: [] });
if (stored.recent.length) {
  recentSection.hidden = false;
  for (const url of stored.recent) {
    const item = classifyArcGisUrl(url);
    if (item) recentList.append(choiceButton(item));
  }
}
