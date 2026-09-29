import type { AgentRunner } from "./agent.js";
import type { BrowserDriver } from "./driver.js";
import type { RunStorage } from "./storage.js";
import type { ActionLogEntry, Finding } from "./types.js";
import type { Logger } from "./util.js";

// What each app (CLI, extension) plugs into the shared pipeline.
export interface RunContext {
  runner: AgentRunner;
  storage: RunStorage;
  // A fresh, unstarted browser for one session or for recon. `label` prefixes screenshot names.
  createDriver(label: string): BrowserDriver;
  log: Logger;
  verbose?: boolean;
  // Stops every agent run in the pipeline (the extension's Stop button).
  signal?: AbortSignal;
  observer?: RunObserver;
}

// Live progress for a UI. All optional; the CLI uses the log instead.
export interface RunObserver {
  action?(sessionId: string, entry: ActionLogEntry): void;
  finding?(finding: Finding): void;
  // Running cost of one agent run ("planner", "S01", "triage").
  cost?(runName: string, costUsd: number): void;
}
