// Run history and artifacts (reports, screenshots, session logs) in IndexedDB. Everything stays in
// this browser profile; nothing is uploaded anywhere.
import type { ClientConfig, RunStorage, TestPlan } from "@exploratory-agent/core";

export type RunMode = "quick" | "full";
export type RunStatus = "running" | "done" | "stopped" | "error";

export interface RunRecord {
  id: string;
  createdAt: string;
  mode: RunMode;
  status: RunStatus;
  name: string;
  origin: string;
  config: ClientConfig;
  plan?: TestPlan;
  // The page Quick mode started on.
  pageUrl?: string;
  totals?: { issues: number; confirmed: number; toVerify: number; autos: number; costUsd: number };
  error?: string;
}

interface FileRecord {
  runId: string;
  path: string;
  data: string | Uint8Array;
}

const DB_NAME = "exploratory-agent";

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("runs", { keyPath: "id" });
      const files = db.createObjectStore("files", { keyPath: ["runId", "path"] });
      files.createIndex("byRun", "runId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name: "runs" | "files", mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const newRunId = (): string => `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`;

export async function saveRun(run: RunRecord): Promise<void> {
  await done((await store("runs", "readwrite")).put(run));
}

export async function getRun(id: string): Promise<RunRecord | undefined> {
  return done((await store("runs")).get(id));
}

export async function listRuns(): Promise<RunRecord[]> {
  const runs: RunRecord[] = await done((await store("runs")).getAll());
  return runs.sort((runA, runB) => runB.createdAt.localeCompare(runA.createdAt));
}

export async function deleteRun(id: string): Promise<void> {
  await done((await store("runs", "readwrite")).delete(id));
  const files = await store("files", "readwrite");
  const keys = await done(files.index("byRun").getAllKeys(id));
  await Promise.all(keys.map((key) => done(files.delete(key))));
}

export async function getFile(runId: string, path: string): Promise<string | Uint8Array | undefined> {
  const record: FileRecord | undefined = await done((await store("files")).get([runId, path]));
  return record?.data;
}

export async function listFiles(runId: string): Promise<string[]> {
  const records: FileRecord[] = await done((await store("files")).index("byRun").getAll(runId));
  return records.map((record) => record.path);
}

export function runStorage(runId: string): RunStorage {
  return {
    async write(path, data) {
      await done((await store("files", "readwrite")).put({ runId, path, data } satisfies FileRecord));
    },
  };
}
