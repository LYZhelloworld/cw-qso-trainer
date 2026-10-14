import type { LogRecord } from "../logRecord.js";

/**
 * Log persistence (IndexedDB), per UI.md. Deliberately write-only outwards:
 * there is no export path, matching the "no ADIF/CSV/JSON export" rule.
 */

const DB_NAME = "cw-qso-trainer";
const DB_VERSION = 1;
const STORE = "logs";

/** False under Node (no indexedDB); callers degrade gracefully. */
export function logsAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function run<T>(
  mode: IDBTransactionMode,
  exec: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = exec(tx.objectStore(STORE));
        req.onsuccess = () => {
          resolve(req.result);
          db.close();
        };
        req.onerror = () => {
          reject(req.error ?? new Error("IndexedDB request failed"));
          db.close();
        };
      }),
  );
}

export async function listLogs(): Promise<LogRecord[]> {
  if (!logsAvailable()) return [];
  try {
    const rows = await run<LogRecord[]>("readonly", (s) => s.getAll());
    return [...rows].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  } catch {
    return [];
  }
}

export async function addLog(record: LogRecord): Promise<void> {
  if (!logsAvailable()) return;
  try {
    await run("readwrite", (s) => s.add(record));
  } catch {
    // Ignore: a failed write must not interrupt the QSO flow.
  }
}

/** Manual edit support (UI.md): replace the stored row with the edited one. */
export async function updateLog(record: LogRecord): Promise<void> {
  if (!logsAvailable()) return;
  try {
    await run("readwrite", (s) => s.put(record));
  } catch {
    // Ignore.
  }
}

export async function clearLogs(): Promise<void> {
  if (!logsAvailable()) return;
  try {
    await run("readwrite", (s) => s.clear());
  } catch {
    // Ignore.
  }
}
