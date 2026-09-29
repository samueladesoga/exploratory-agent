// Test-only page (built with --test-harness): exposes the driver and core to Playwright tests.
import * as core from "@exploratory-agent/core";
import { CdpDriver } from "./cdp-driver.js";

const files = new Map<string, string | Uint8Array>();
const storage: core.RunStorage = { write: async (path, data) => void files.set(path, data) };

// Test functions arrive via Playwright's page.evaluate after tsx compiled them with esbuild's
// keepNames, which wraps functions in a __name() helper that doesn't exist in the page.
Object.assign(globalThis, { harness: { core, CdpDriver, storage, files }, __name: (target: unknown) => target });
document.title = "harness ready";
