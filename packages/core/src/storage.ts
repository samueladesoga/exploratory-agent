// Where a run's artifacts go (plan, session logs, screenshots, reports). Paths are relative to the
// run, e.g. "sessions/S01.json" or "screens/S01-001-cart.jpg". The CLI writes to a run directory on
// disk; the extension writes to IndexedDB.
export interface RunStorage {
  write(relativePath: string, data: string | Uint8Array): Promise<void>;
}
