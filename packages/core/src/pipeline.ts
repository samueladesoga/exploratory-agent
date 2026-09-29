import type { ClientConfig } from "./config.js";
import type { RunContext } from "./context.js";
import { runSession } from "./explorer.js";
import type { RunReport } from "./report.js";
import { autoFindings, triage } from "./triage.js";
import type { Charter, Signal, TestPlan } from "./types.js";
import { pool } from "./util.js";

// The one-click "Find bugs on this page" charter: no recon or planning, one session on the given page.
export function quickCharter(cfg: ClientConfig, pageUrl: string, pageTitle: string): Charter {
  const where = pageTitle.trim() || new URL(pageUrl).pathname;
  return {
    id: "C01",
    title: `Quick check: ${where}`,
    mission: `Explore ${pageUrl} and the flows reachable from it with realistic and edge-case inputs to discover functional, validation, error-handling and layout defects a user would notice`,
    area: where,
    startUrl: pageUrl,
    risks: [
      "Forms that accept invalid input or reject valid input",
      "Actions that fail silently or show misleading feedback",
      "Broken links, dead ends and runtime errors",
      "Layout problems at phone width",
    ],
    techniques: ["Boundary and format inputs on every form", "Flow disruption: back, reload, double submit", "One pass at a 390x844 viewport"],
    priority: "high",
    maxSteps: cfg.run.maxStepsPerSession,
  };
}

export function quickPlan(cfg: ClientConfig, pageUrl: string, pageTitle: string): TestPlan {
  return {
    client: cfg.name,
    baseUrl: cfg.baseUrl,
    createdAt: new Date().toISOString(),
    overview: "Quick check of a single page: one session, no reconnaissance or planning.",
    charters: [quickCharter(cfg, pageUrl, pageTitle)],
  };
}

export interface ExecuteOptions {
  // Runtime signals seen before the sessions (recon), included in the automatic error groups.
  priorSignals?: Signal[];
  // Cost already spent on planning, carried into the report total.
  priorCostUsd?: number;
  startedAt?: string;
}

// Runs the charters as sessions, triages everything they found, and returns the report data.
export async function executePlan(cfg: ClientConfig, plan: TestPlan, charters: Charter[], ctx: RunContext, opts: ExecuteOptions = {}): Promise<RunReport> {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  ctx.log(`Running ${charters.length} session(s), ${cfg.run.concurrency} at a time…`);
  const sessions = await pool(charters, cfg.run.concurrency, (charter) => runSession(cfg, charter, ctx));

  ctx.log("Triaging findings…");
  const autos = autoFindings([...(opts.priorSignals ?? []), ...sessions.flatMap((session) => session.signals)]);
  const triaged = await triage(cfg, sessions, autos, ctx);

  return {
    cfg,
    plan,
    sessions,
    issues: triaged.issues,
    autos,
    summary: triaged.summary,
    totalCostUsd: (opts.priorCostUsd ?? 0) + sessions.reduce((sum, session) => sum + session.costUsd, 0) + triaged.costUsd,
    startedAt,
    endedAt: new Date().toISOString(),
  };
}
