import { contestOf, roundOf, type LogRecord } from "../logRecord.js";
import type { ContestKind } from "../../qso/contest.js";

/**
 * Log persistence (IndexedDB), per LOG.md. Deliberately write-only outwards:
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

/** Manual edit support (LOG.md): replace the stored row with the edited one. */
export async function updateLog(record: LogRecord): Promise<void> {
  if (!logsAvailable()) return;
  try {
    await run("readwrite", (s) => s.put(record));
  } catch {
    // Ignore.
  }
}

/** Delete one row — the operator deciding this contact never happened. */
export async function deleteLog(id: number): Promise<void> {
  if (!logsAvailable()) return;
  try {
    await run("readwrite", (s) => s.delete(id));
  } catch {
    // Ignore.
  }
}

/**
 * Empty the sessions before this one, leaving the current run alone.
 *
 * The history view's clear button: an archive is a separate thing from the book
 * being written, so wiping it must never take the live run with it.
 */
export async function clearPastLogs(contest: ContestKind, round: number): Promise<void> {
  if (!logsAvailable()) return;
  try {
    const rows = await run<LogRecord[]>("readonly", (s) => s.getAll());
    const ids = rows
      .filter((row) => contestOf(row) === contest && roundOf(row) < round)
      .map((row) => row.id)
      .filter((id): id is number => typeof id === "number");
    if (ids.length === 0) return;
    await run("readwrite", (s) => {
      for (const id of ids) s.delete(id);
      return s.count();
    });
  } catch {
    // Ignore.
  }
}

/**
 * Empty a log. With a contest it empties **only that log**: the three books are
 * separate records of three separate modes, and clearing a botched WPX run must
 * not take the operator's DX log with it. Without an argument it empties all of
 * them, which is what the log page's "clear everything" path asks for.
 *
 * A `round` narrows it further, to one contest session — the log page's clear
 * button empties what is on screen, and what is on screen is one session.
 */
export async function clearLogs(contest?: ContestKind, round?: number): Promise<void> {
  if (!logsAvailable()) return;
  try {
    if (contest === undefined) {
      await run("readwrite", (s) => s.clear());
      return;
    }
    const rows = await run<LogRecord[]>("readonly", (s) => s.getAll());
    const ids = rows
      .filter((row) => contestOf(row) === contest && (round === undefined || roundOf(row) === round))
      .map((row) => row.id)
      .filter((id): id is number => typeof id === "number");
    if (ids.length === 0) return;
    await run("readwrite", (s) => {
      for (const id of ids) s.delete(id);
      // The returned request is what the transaction's completion rides on.
      return s.count();
    });
  } catch {
    // Ignore.
  }
}
