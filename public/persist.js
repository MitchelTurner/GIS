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

export async function saveKey(key, value) {
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
