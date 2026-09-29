import type { AgentRunner } from "./agent.js";
import type { BrowserDriver } from "./driver.js";
import type { RunStorage } from "./storage.js";
import type { Logger } from "./util.js";

// What each app (CLI, extension) plugs into the shared pipeline.
export interface RunContext {
  runner: AgentRunner;
  storage: RunStorage;
  // A fresh, unstarted browser for one session or for recon. `label` prefixes screenshot names.
  createDriver(label: string): BrowserDriver;
  log: Logger;
  verbose?: boolean;
}
