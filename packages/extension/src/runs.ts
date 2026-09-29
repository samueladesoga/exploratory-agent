// Runs the shared core pipeline inside the side panel: the CDP driver for browsers, the Messages
// API runner for agents, and IndexedDB for artifacts. The side panel must stay open during a run,
// because chrome.debugger is only available to extension pages (not offscreen documents).
import {
  createPlan,
  executePlan,
  makeLogger,
  planToMarkdown,
  quickPlan,
  reconnoitre,
  renderReports,
  messagesApiRunner,
  type Charter,
  type ClientConfig,
  type Finding,
  type ActionLogEntry,
  type RunContext,
  type RunReport,
  type Signal,
  type TestPlan,
} from "@exploratory-agent/core";
import { CdpDriver } from "./cdp-driver.js";
import { newRunId, runStorage, saveRun, type RunMode, type RunRecord } from "./db.js";

export interface RunHandlers {
  onLog?(line: string): void;
  onAction?(sessionId: string, entry: ActionLogEntry): void;
  onFinding?(finding: Finding): void;
  onCost?(totalUsd: number): void;
}

export interface ActiveRun {
  record: RunRecord;
  stop(): void;
  readonly stopped: boolean;
}

interface Setup {
  apiKey: string;
  windowId?: number;
  handlers: RunHandlers;
}

function context(cfg: ClientConfig, record: RunRecord, setup: Setup, controller: AbortController, priorCostUsd = 0): RunContext {
  const storage = runStorage(record.id);
  const costs = new Map<string, number>();
  const consoleLog = makeLogger();
  return {
    runner: messagesApiRunner({ apiKey: setup.apiKey, browser: true }),
    storage,
    createDriver: (label) => new CdpDriver(cfg, { storage, label, windowId: setup.windowId, onUserDetach: () => controller.abort() }),
    log: (line) => {
      consoleLog(line);
      setup.handlers.onLog?.(line);
    },
    signal: controller.signal,
    observer: {
      action: setup.handlers.onAction,
      finding: setup.handlers.onFinding,
      cost: (name, costUsd) => {
        costs.set(name, costUsd);
        setup.handlers.onCost?.(priorCostUsd + [...costs.values()].reduce((sum, value) => sum + value, 0));
      },
    },
  };
}

function newRecord(cfg: ClientConfig, mode: RunMode, extra: Partial<RunRecord> = {}): RunRecord {
  return { id: newRunId(), createdAt: new Date().toISOString(), mode, status: "running", name: cfg.name, origin: new URL(cfg.baseUrl).origin, config: cfg, ...extra };
}

async function finish(record: RunRecord, report: RunReport, stopped: boolean): Promise<RunRecord> {
  const storage = runStorage(record.id);
  for (const [file, contents] of Object.entries(renderReports(report))) await storage.write(file, contents);
  const toVerify = report.issues.filter((issue) => issue.needsVerification).length;
  const finished: RunRecord = {
    ...record,
    status: stopped ? "stopped" : "done",
    totals: { issues: report.issues.length, confirmed: report.issues.length - toVerify, toVerify, autos: report.autos.length, costUsd: report.totalCostUsd },
  };
  await saveRun(finished);
  return finished;
}

async function fail(record: RunRecord, err: unknown): Promise<never> {
  await saveRun({ ...record, status: "error", error: err instanceof Error ? err.message : String(err) });
  throw err;
}

// Quick mode: one session on the given page, then triage.
export function startQuickRun(cfg: ClientConfig, pageUrl: string, pageTitle: string, setup: Setup): { active: ActiveRun; done: Promise<{ record: RunRecord; report: RunReport }> } {
  const controller = new AbortController();
  const plan = quickPlan(cfg, pageUrl, pageTitle);
  const record = newRecord(cfg, "quick", { plan, pageUrl });
  const active: ActiveRun = { record, stop: () => controller.abort(), get stopped() { return controller.signal.aborted; } };
  const done = (async () => {
    await saveRun(record);
    try {
      const report = await executePlan(cfg, plan, plan.charters, context(cfg, record, setup, controller));
      return { record: await finish(record, report, controller.signal.aborted), report };
    } catch (err) {
      return fail(record, err);
    }
  })();
  return { active, done };
}

export interface PlannedRun {
  record: RunRecord;
  plan: TestPlan;
  reconSignals: Signal[];
  planCostUsd: number;
}

// Full mode, part 1: map the site and write charters, then stop for the user to review them.
export function startPlanning(cfg: ClientConfig, setup: Setup): { active: ActiveRun; done: Promise<PlannedRun> } {
  const controller = new AbortController();
  const record = newRecord(cfg, "full");
  const active: ActiveRun = { record, stop: () => controller.abort(), get stopped() { return controller.signal.aborted; } };
  const done = (async () => {
    await saveRun(record);
    try {
      const ctx = context(cfg, record, setup, controller);
      ctx.log("Reconnaissance: mapping the application…");
      const recon = await reconnoitre(cfg, ctx);
      await ctx.storage.write("sitemap.md", recon.siteMap);
      ctx.log(`Planning ${cfg.run.sessions} charters from ${recon.pagesVisited} pages…`);
      const { plan, costUsd } = await createPlan(cfg, recon.siteMap, ctx);
      await ctx.storage.write("plan.json", JSON.stringify(plan, null, 2));
      await ctx.storage.write("plan.md", planToMarkdown(plan));
      const planned = { ...record, plan };
      await saveRun(planned);
      return { record: planned, plan, reconSignals: recon.signals, planCostUsd: costUsd };
    } catch (err) {
      return fail(record, err);
    }
  })();
  return { active, done };
}

// Full mode, part 2 (and "Run again"): run the chosen charters, then triage.
export function startExecution(
  cfg: ClientConfig,
  plan: TestPlan,
  charters: Charter[],
  setup: Setup,
  prior: { record?: RunRecord; reconSignals?: Signal[]; planCostUsd?: number } = {},
): { active: ActiveRun; done: Promise<{ record: RunRecord; report: RunReport }> } {
  const controller = new AbortController();
  const record: RunRecord = prior.record ? { ...prior.record, status: "running", config: cfg, plan } : newRecord(cfg, "full", { plan });
  const active: ActiveRun = { record, stop: () => controller.abort(), get stopped() { return controller.signal.aborted; } };
  const done = (async () => {
    await saveRun(record);
    try {
      const ctx = context(cfg, record, setup, controller, prior.planCostUsd ?? 0);
      const report = await executePlan(cfg, plan, charters, ctx, { priorSignals: prior.reconSignals, priorCostUsd: prior.planCostUsd });
      return { record: await finish(record, report, controller.signal.aborted), report };
    } catch (err) {
      return fail(record, err);
    }
  })();
  return { active, done };
}

// The demo: log in to saucedemo.com as its deliberately buggy "problem_user" (public demo
// credentials printed on its login page), in the tab group the runs use.
export async function demoLogin(cfg: ClientConfig, windowId?: number): Promise<void> {
  const driver = new CdpDriver(cfg, { storage: { write: async () => {} }, label: "demo", windowId });
  await driver.start();
  try {
    await driver.navigate("https://www.saucedemo.com/");
    const snapshot = await driver.snapshot(20000);
    const ref = (pattern: RegExp) => {
      const match = snapshot.split("\n").find((line) => pattern.test(line))?.match(/\[ref=(e\d+)\]/);
      if (!match) throw new Error("The demo site's login page has changed; try again later.");
      return match[1];
    };
    await driver.fill(ref(/textbox "Username"/), "problem_user");
    await driver.fill(ref(/textbox "Password"/), "secret_sauce");
    await driver.click(ref(/button "Login"/));
  } finally {
    await driver.close();
  }
}

export const DEMO_CONFIG = {
  name: "Sauce Demo (demo)",
  baseUrl: "https://www.saucedemo.com/",
  description:
    "Swag Labs, a demo online shop. Logged in as problem_user, an account the site deliberately breaks. Customers browse products, sort them, add items to the cart and check out with a name and postal code. Prices and totals must be consistent. Each product image should match its product.",
  focusAreas: ["Product images and details", "Sorting", "Cart and checkout"],
  outOfScope: [],
  testData: { customer: "first name Test, last name Tester, postal code SW1A 1AA" },
  safety: { ignoreSignals: ["backtrace\\.io|events\\.backtrace"] },
};
