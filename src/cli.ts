import "dotenv/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { prepareAuth } from "./auth.js";
import { loadClientConfig } from "./config.js";
import { runSession } from "./explorer.js";
import { createPlan, planToMarkdown } from "./planner.js";
import { reconnoitre } from "./recon.js";
import { autoFindings, triage, writeReports } from "./reporter.js";
import type { Signal, TestPlan } from "./types.js";
import { errMsg, makeLogger, pool, slug, stamp } from "./util.js";

const USAGE = `Usage: npm run explore -- --client clients/<client>.yaml [options]

Options:
  --client, -c <file>   Client config (required)
  --plan-only           Run recon and planning, then stop so you can review/edit plan.json
  --plan <file>         Skip planning and execute an existing plan.json
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

  const log = makeLogger();
  const cfg = await loadClientConfig(values.client);
  if (values.sessions) cfg.run.sessions = Number(values.sessions);
  const headless = values.headed ? false : cfg.browser.headless;
  if (!process.env.ANTHROPIC_API_KEY) log("⚠ ANTHROPIC_API_KEY is not set; the SDK will try other configured credentials.");

  const startedAt = new Date().toISOString();
  const runDir = path.resolve(values.out!, slug(cfg.name), stamp());
  await mkdir(path.join(runDir, "sessions"), { recursive: true });
  await mkdir(path.join(runDir, "screens"), { recursive: true });
  log(`Client: ${cfg.name} (${cfg.baseUrl})`);
  log(`Output: ${runDir}`);

  const auth = await prepareAuth(cfg, runDir, headless, log);
  let totalCostUsd = 0;
  let reconSignals: Signal[] = [];

  try {
    let plan: TestPlan;
    if (values.plan) {
      plan = JSON.parse(await readFile(values.plan, "utf8")) as TestPlan;
      log(`Loaded plan with ${plan.charters.length} charters from ${values.plan}`);
    } else {
      log("Reconnaissance: mapping the application…");
      const recon = await reconnoitre(cfg, { storageState: auth.storageState, screensDir: path.join(runDir, "screens"), headless, log });
      reconSignals = recon.signals;
      await writeFile(path.join(runDir, "sitemap.md"), recon.siteMap);
      log(`Planning ${cfg.run.sessions} charters from ${recon.pagesVisited} pages…`);
      const planned = await createPlan(cfg, recon.siteMap, { cwd: runDir, log });
      plan = planned.plan;
      totalCostUsd += planned.costUsd;
    }
    await writeFile(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
    await writeFile(path.join(runDir, "plan.md"), planToMarkdown(plan));
    plan.charters.forEach((charter) => log(`  ${charter.id} [${charter.priority}] ${charter.title}`));

    if (values["plan-only"]) {
      log(`Plan written to ${path.join(runDir, "plan.md")}. Review/edit plan.json, then run with --plan ${path.join(runDir, "plan.json")}`);
      return;
    }

    let charters = plan.charters;
    if (values.charters) {
      const wantedIds = new Set(values.charters.split(",").map((id) => id.trim().toUpperCase()));
      charters = charters.filter((charter) => wantedIds.has(charter.id));
    }
    log(`Running ${charters.length} session(s), ${cfg.run.concurrency} at a time…`);
    const sessions = await pool(charters, cfg.run.concurrency, (charter) =>
      runSession(cfg, charter, { runDir, storageState: auth.storageState, headless, verbose: values.verbose!, log }),
    );
    totalCostUsd += sessions.reduce((sum, session) => sum + session.costUsd, 0);

    log("Triaging findings…");
    const autos = autoFindings([...reconSignals, ...sessions.flatMap((session) => session.signals)]);
    const triaged = await triage(cfg, sessions, autos, { cwd: runDir, log });
    totalCostUsd += triaged.costUsd;

    await writeReports(
      runDir,
      {
        cfg,
        plan,
        sessions,
        issues: triaged.issues,
        autos,
        summary: triaged.summary,
        totalCostUsd,
        startedAt,
        endedAt: new Date().toISOString(),
      },
      log,
    );

    const issueCountBySeverity = triaged.issues.reduce<Record<string, number>>((counts, issue) => {
      const key = issue.needsVerification ? "to verify" : issue.severity;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    log(
      `Done. ${triaged.issues.length} issue(s) ${JSON.stringify(issueCountBySeverity)}, ${autos.length} runtime error pattern(s). Est. cost $${totalCostUsd.toFixed(2)}`,
    );
    log(`Report: ${path.join(runDir, "report.html")}`);
  } finally {
    if (auth.temporary && auth.storageState) await rm(auth.storageState, { force: true });
  }
}

main().catch((err) => {
  console.error(`\n✖ ${errMsg(err)}`);
  process.exit(1);
});
