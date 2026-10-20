import { defineTool } from "./agent.js";
import type { ClientConfig } from "./config.js";
import type { RunContext } from "./context.js";
import { buildPlan, FollowUpSubmissionShape } from "./planner.js";
import { followUpPlannerPrompt, PLANNER_SYSTEM, type GapForPrompt } from "./prompts.js";
import type { Issue, SessionResult, TestPlan } from "./types.js";
import { text } from "./util.js";

// What a follow-up needs from an earlier run: its report.json, plus its site map if there is one.
export interface PriorRun {
  // Where the earlier run lives, shown in the new plan and report (e.g. "runs/acme/2026-10-20_1015").
  label: string;
  sessions: SessionResult[];
  issues: Issue[];
  siteMap?: string;
}

// Sessions that left something uncovered: either the tester listed gaps, or the session stopped
// before it could say (budget, timeout, error, abort).
export function coverageGaps(sessions: SessionResult[]): GapForPrompt[] {
  return sessions
    .filter((session) => session.areasNotCovered.length > 0 || session.stopReason !== "completed")
    .map((session) => ({
      charter: session.charter,
      stopReason: session.stopReason,
      stepsUsed: session.stepsUsed,
      summary: session.summary,
      covered: session.areasCovered,
      notCovered: session.areasNotCovered,
    }));
}

// Adds the earlier run's issues to the known issues, so the planner and testers don't report them again.
export function withPriorIssues(cfg: ClientConfig, issues: Issue[]): ClientConfig {
  const known = new Set(cfg.knownIssues);
  const added = issues.map((issue) => `${issue.title} (on ${issue.primary.pageUrl}, reported earlier as ${issue.id})`).filter((entry) => !known.has(entry));
  return { ...cfg, knownIssues: [...cfg.knownIssues, ...added] };
}

export interface FollowUpPlanResult {
  plan: TestPlan;
  gaps: GapForPrompt[];
  costUsd: number;
}

// Plans charters aimed at the earlier run's gaps. Returns an empty plan without calling the model
// when nothing was left uncovered. Pass a cfg that already includes the prior issues (withPriorIssues).
export async function createFollowUpPlan(
  cfg: ClientConfig,
  prior: PriorRun,
  ctx: Pick<RunContext, "runner" | "log" | "signal" | "observer">,
  maxCharters?: number,
): Promise<FollowUpPlanResult> {
  const gaps = coverageGaps(prior.sessions);
  const parents = new Map(gaps.map((gap) => [gap.charter.id, gap.charter]));
  if (!gaps.length) {
    const overview = "Every session in the earlier run covered its charter. Nothing to follow up.";
    return { plan: buildPlan(cfg, { overview, charters: [] }, { followUpOf: prior.label }), gaps, costUsd: 0 };
  }

  // By default, room for one charter per gap session, or per listed gap when a session listed several.
  const listedGaps = gaps.reduce((sum, gap) => sum + gap.notCovered.length, 0);
  const limit = Math.max(1, maxCharters ?? Math.max(gaps.length, listedGaps));

  let plan: TestPlan | undefined;
  const submitPlan = defineTool("submit_plan", "Submit the follow-up test plan.", FollowUpSubmissionShape, async (submission) => {
    plan = buildPlan(cfg, { ...submission, charters: submission.charters.slice(0, limit) }, { parents, followUpOf: prior.label });
    return text(`Plan received with ${plan.charters.length} charters. You are done.`);
  });

  const run = await ctx.runner.run({
    name: "planner",
    systemPrompt: PLANNER_SYSTEM,
    prompt: followUpPlannerPrompt(cfg, gaps, limit, prior.siteMap),
    tools: [submitPlan],
    model: cfg.run.plannerModel,
    maxTurns: 4,
    log: ctx.log,
    signal: ctx.signal,
    onTurn: (progress) => ctx.observer?.cost?.("planner", progress.costUsd),
  });

  if (!plan) throw new Error(`Planner finished without submitting a follow-up plan (stop reason: ${run.stopReason}).`);
  return { plan, gaps, costUsd: run.costUsd };
}
