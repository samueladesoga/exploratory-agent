import "dotenv/config";
import {
  createFollowUpPlan,
  createPlan,
  errMsg,
  executePlan,
  makeLogger,
  parseClientConfigYaml,
  planToMarkdown,
  reconnoitre,
  renderReports,
  slug,
  stamp,
  type PriorRun,
  type RunContext,
  type RunReport,
  type Signal,
  type TestPlan,
  withPriorIssues,
} from "@exploratory-agent/core";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { prepareAuth } from "./auth.js";
import { fsStorage } from "./fs-storage.js";
import { renderPdf } from "./pdf.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { sdkRunner } from "./sdk-runner.js";

const USAGE = `Usage: npm run explore -- --client clients/<client>.yaml [options]

Options:
  --client, -c <file>   Client config (required)
  --plan-only           Run recon and planning, then stop so you can review/edit plan.json
  --plan <file>         Skip planning and execute an existing plan.json
  --follow-up <run>     Plan and run sessions that target what an earlier run didn't cover
                        (pass its run directory, e.g. runs/acme/<timestamp>)
  --charters <ids>      Only run these charters, e.g. C01,C03
  --sessions <n>        Override the number of charters to plan
  --headed              Show the browser windows
  --verbose             Also log the agent's reasoning text
  --out <dir>           Output root (default: runs)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      client: { type: "string", short: "c" },
      "plan-only": { type: "boolean", default: false },
      plan: { type: "string" },
      "follow-up": { type: "string" },
      charters: { type: "string" },
      sessions: { type: "string" },
      headed: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      out: { type: "string", default: "runs" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || !values.client) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  if (values.plan && values["follow-up"]) {
    console.error("Use either --plan or --follow-up, not both.");
    process.exit(1);
  }

  const log = makeLogger();
  let cfg = parseClientConfigYaml(await readFile(values.client, "utf8"), values.client);
  if (values.sessions) cfg.run.sessions = Number(values.sessions);
  const headless = values.headed ? false : cfg.browser.headless;
  if (!process.env.ANTHROPIC_API_KEY) log("⚠ ANTHROPIC_API_KEY is not set; the SDK will try other configured credentials.");

  // Earlier issues become known issues, so this run's planner and testers don't report them again.
  const prior = values["follow-up"] ? await loadPriorRun(values["follow-up"], cfg.name, log) : undefined;
  if (prior) cfg = withPriorIssues(cfg, prior.issues);

  const startedAt = new Date().toISOString();
  const runDir = path.resolve(values.out!, slug(cfg.name), stamp());
  const storage = fsStorage(runDir);
  log(`Client: ${cfg.name} (${cfg.baseUrl})`);
  log(`Output: ${runDir}`);

  const auth = await prepareAuth(cfg, runDir, headless, log);
  const ctx: RunContext = {
    runner: sdkRunner(runDir),
    storage,
    createDriver: (label) => new PlaywrightDriver(cfg, { storage, label, headless, storageState: auth.storageState }),
    log,
    verbose: values.verbose,
  };
  let planCostUsd = 0;
  let reconSignals: Signal[] = [];

  try {
    let plan: TestPlan;
    if (values.plan) {
      plan = JSON.parse(await readFile(values.plan, "utf8")) as TestPlan;
      log(`Loaded plan with ${plan.charters.length} charters from ${values.plan}`);
    } else if (prior) {
      if (prior.siteMap) await storage.write("sitemap.md", prior.siteMap);
      log(`Planning a follow-up of ${prior.label}…`);
      const planned = await createFollowUpPlan(cfg, prior, ctx, values.sessions ? Number(values.sessions) : undefined);
      log(`${planned.gaps.length} of ${prior.sessions.length} earlier session(s) left gaps: ${planned.gaps.map((gap) => gap.charter.id).join(", ") || "none"}`);
      plan = planned.plan;
      planCostUsd = planned.costUsd;
    } else {
      log("Reconnaissance: mapping the application…");
      const recon = await reconnoitre(cfg, ctx);
      reconSignals = recon.signals;
      await storage.write("sitemap.md", recon.siteMap);
      log(`Planning ${cfg.run.sessions} charters from ${recon.pagesVisited} pages…`);
      const planned = await createPlan(cfg, recon.siteMap, ctx);
      plan = planned.plan;
      planCostUsd = planned.costUsd;
    }
    await storage.write("plan.json", JSON.stringify(plan, null, 2));
    await storage.write("plan.md", planToMarkdown(plan));
    plan.charters.forEach((charter) => log(`  ${charter.id} [${charter.priority}] ${charter.title}${charter.followsUp ? ` (follows up ${charter.followsUp})` : ""}`));
    if (!plan.charters.length) {
      log(`Nothing to run: ${plan.overview}`);
      return;
    }

    if (values["plan-only"]) {
      log(`Plan written to ${path.join(runDir, "plan.md")}. Review/edit plan.json, then run with --plan ${path.join(runDir, "plan.json")}`);
      return;
    }

    let charters = plan.charters;
    if (values.charters) {
      const wantedIds = new Set(values.charters.split(",").map((id) => id.trim().toUpperCase()));
      charters = charters.filter((charter) => wantedIds.has(charter.id));
    }
    const report = await executePlan(cfg, plan, charters, ctx, { priorSignals: reconSignals, priorCostUsd: planCostUsd, startedAt });
    for (const [file, contents] of Object.entries(renderReports(report))) await storage.write(file, contents);
    await renderPdf(path.join(runDir, "report.html"), path.join(runDir, "report.pdf")).catch((err) => log(`report.pdf skipped: ${errMsg(err)}`));

    const issueCountBySeverity = report.issues.reduce<Record<string, number>>((counts, issue) => {
      const key = issue.needsVerification ? "to verify" : issue.severity;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    log(
      `Done. ${report.issues.length} issue(s) ${JSON.stringify(issueCountBySeverity)}, ${report.autos.length} runtime error pattern(s). Est. cost $${report.totalCostUsd.toFixed(2)}`,
    );
    log(`Report: ${path.join(runDir, "report.html")}`);
  } finally {
    if (auth.temporary && auth.storageState) await rm(auth.storageState, { force: true });
  }
}

// Reads an earlier run's report.json (and sitemap.md, if it has one) for --follow-up.
async function loadPriorRun(target: string, clientName: string, log: (message: string) => void): Promise<PriorRun> {
  const runDir = path.basename(target) === "report.json" ? path.dirname(target) : target;
  let report: RunReport;
  try {
    report = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8")) as RunReport;
  } catch (err) {
    throw new Error(`Can't read ${path.join(runDir, "report.json")} (${errMsg(err)}). --follow-up needs a run that finished and wrote its report.`);
  }
  if (report.cfg.name !== clientName) log(`⚠ ${runDir} was a run for "${report.cfg.name}", not "${clientName}".`);
  const siteMap = await readFile(path.join(runDir, "sitemap.md"), "utf8").catch(() => undefined);
  const relative = path.relative(process.cwd(), path.resolve(runDir));
  const label = relative && !relative.startsWith("..") ? relative : path.resolve(runDir);
  return { label, sessions: report.sessions, issues: report.issues, siteMap };
}

main().catch((err) => {
  console.error(`\n✖ ${errMsg(err)}`);
  process.exit(1);
});
