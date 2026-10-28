// Tiny promise wrapper around IndexedDB. Everything the app knows lives here, on the device.

const DB_NAME = 'walktracker';
const VERSION = 2;
const STORES = ['tracks', 'areas', 'overrides'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tracks')) {
          db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('areas')) {
          db.createObjectStore('areas', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('overrides')) {
          db.createObjectStore('overrides'); // key: block id, value: boolean
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta'); // device settings such as the Mapbox token; not in backups
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key)),
  delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),

  async overrides() {
    const dbi = await open();
    return new Promise((resolve, reject) => {
      const out = {};
      const tx = dbi.transaction('overrides', 'readonly');
      const req = tx.objectStore('overrides').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out[c.key] = c.value; c.continue(); }
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  },

  // Full backup: one JSON file with everything.
  async exportAll() {
    return {
      app: 'walktracker',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      tracks: await this.all('tracks'),
      overrides: await this.overrides(),
    };
  },

  // Merges a backup into what's already here. Walks get new ids to avoid clashes.
  async importAll(data) {
    if (!data || data.app !== 'walktracker') throw new Error('Not a WalkTracker backup file');
    // Skip anything that's already here so importing the same backup twice is harmless.
    const trackKey = (t) => `${t.startedAt}|${t.points.length}`;
    const haveTracks = new Set((await this.all('tracks')).map(trackKey));
    for (const t of data.tracks || []) {
      if (haveTracks.has(trackKey(t))) continue;
      const { id, ...rest } = t;
      await this.put('tracks', rest);
    }
    // Older backups also have custom "areas"; the app now uses NYC's neighborhoods instead.
    for (const [k, v] of Object.entries(data.overrides || {})) await this.put('overrides', v, k);
  },
};

export { STORES };
