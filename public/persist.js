function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ketchikan-parcels', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadKey(key) {
  const db = await openDb();
  try {
    return await readRequest(db.transaction('kv').objectStore('kv').get(key));
  } finally {
    db.close();
  }
}

// Keys every device shares once the server has a database.
export const SHARED_KEYS = ['outreach', 'links', 'buybox', 'searches', 'changes', 'edits'];
let shared = false;
let onSyncError = () => {};

export function shareWithServer(on, { onError } = {}) {
  shared = Boolean(on);
  if (onError) onSyncError = onError;
}

export async function fetchShared() {
  const res = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('The server did not send the shared settings.');
  return res.json();
}

export async function pushShared(key, value) {
  const res = await fetch(`/api/state/${encodeURIComponent(key)}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: value ?? null }),
  });
  if (!res.ok) throw new Error(`The server did not save ${key}.`);
}

export async function saveKey(key, value) {
  await saveLocal(key, value);
  if (shared && SHARED_KEYS.includes(key)) {
    try {
      await pushShared(key, value);
    } catch (error) {
      onSyncError(error);
    }
  }
}

export async function saveLocal(key, value) {
  const db = await openDb();
  try {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
