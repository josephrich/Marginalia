// Tiny IndexedDB wrapper. Everything lives on-device.
const DB_NAME = 'marginalia';
const STORE = 'highlights';
let dbp;

function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const getAll = () => tx('readonly', s => s.getAll());
export const putMany = items => tx('readwrite', s => { items.forEach(i => s.put(i)); });
export const remove = id => tx('readwrite', s => { s.delete(id); });
export const clearAll = () => tx('readwrite', s => { s.clear(); });
