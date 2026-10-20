import { z } from "zod";
import { defineTool } from "./agent.js";
import { appOrigins, type ClientConfig } from "./config.js";
import type { RunContext } from "./context.js";
import { PLANNER_SYSTEM, plannerPrompt } from "./prompts.js";
import type { Charter, TestPlan } from "./types.js";
import { text } from "./util.js";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

const CharterInputShape = {
  title: z.string(),
  mission: z.string().describe("Explore <target> with <resources> to discover <information>"),
  area: z.string(),
  start_path: z.string().describe("Path or absolute URL within the app where the session starts"),
  risks: z.array(z.string()),
  techniques: z.array(z.string()),
  priority: z.enum(["high", "medium", "low"]),
};

const PlanSubmissionShape = {
  overview: z.string().describe("2-4 sentences: overall test strategy and the main risks"),
  charters: z.array(z.object(CharterInputShape)).min(1),
};

// A follow-up plan may be empty: the planner can decide no gap is worth another session.
export const FollowUpSubmissionShape = {
  overview: z.string().describe("2-4 sentences: which gaps this follow-up targets and why"),
  charters: z.array(
    z.object({
      ...CharterInputShape,
      follows_up: z.string().describe("Id of the earlier charter whose gaps this charter targets, e.g. C02"),
    }),
  ),
};

export type PlanSubmission = z.infer<z.ZodObject<typeof PlanSubmissionShape>>;
export type FollowUpSubmission = z.infer<z.ZodObject<typeof FollowUpSubmissionShape>>;

export interface BuildPlanOptions {
  // Follow-up runs: the earlier charters by id. A charter's follows_up must name one of these, and
  // a start path that can't be used falls back to that charter's start URL.
  parents?: Map<string, Charter>;
  followUpOf?: string;
}

// Turns the planner's submission into a plan: start paths resolved inside the app's origins,
// charters ordered by priority and numbered C01, C02…
export function buildPlan(cfg: ClientConfig, submission: PlanSubmission | FollowUpSubmission, opts: BuildPlanOptions = {}): TestPlan {
  const origins = appOrigins(cfg);
  const charters: Charter[] = submission.charters
    .map((charterInput: PlanSubmission["charters"][number] & { follows_up?: string }) => {
      const parent = charterInput.follows_up ? opts.parents?.get(charterInput.follows_up.trim().toUpperCase()) : undefined;
      let startUrl = parent?.startUrl ?? cfg.baseUrl;
      try {
        const resolvedUrl = new URL(charterInput.start_path, cfg.baseUrl);
        if (origins.has(resolvedUrl.origin)) startUrl = resolvedUrl.toString();
      } catch {}
      return {
        id: "",
        title: charterInput.title,
        mission: charterInput.mission,
        area: charterInput.area,
        startUrl,
        risks: charterInput.risks,
        techniques: charterInput.techniques,
        priority: charterInput.priority,
        maxSteps: cfg.run.maxStepsPerSession,
        ...(parent ? { followsUp: parent.id } : {}),
      };
    })
    .sort((charterA, charterB) => PRIORITY_ORDER[charterA.priority] - PRIORITY_ORDER[charterB.priority])
    .map((charter, index) => ({ ...charter, id: `C${String(index + 1).padStart(2, "0")}` }));

  return {
    client: cfg.name,
    baseUrl: cfg.baseUrl,
    createdAt: new Date().toISOString(),
    overview: submission.overview,
    charters,
    ...(opts.followUpOf ? { followUpOf: opts.followUpOf } : {}),
  };
}

export async function createPlan(
  cfg: ClientConfig,
  siteMap: string,
  ctx: Pick<RunContext, "runner" | "log" | "signal" | "observer">,
): Promise<{ plan: TestPlan; costUsd: number }> {
  let plan: TestPlan | undefined;

  const submitPlan = defineTool("submit_plan", "Submit the finished exploratory test plan.", PlanSubmissionShape, async (submission) => {
    plan = buildPlan(cfg, submission);
    return text(`Plan received with ${plan.charters.length} charters. You are done.`);
  });

  const run = await ctx.runner.run({
    name: "planner",
    systemPrompt: PLANNER_SYSTEM,
    prompt: plannerPrompt(cfg, siteMap),
    tools: [submitPlan],
    model: cfg.run.plannerModel,
    maxTurns: 4,
    log: ctx.log,
    signal: ctx.signal,
    onTurn: (progress) => ctx.observer?.cost?.("planner", progress.costUsd),
  });

  if (!plan) throw new Error(`Planner finished without submitting a plan (stop reason: ${run.stopReason}).`);
  return { plan, costUsd: run.costUsd };
}

export function planToMarkdown(plan: TestPlan): string {
  const lines = [
    `# Exploratory test plan: ${plan.client}`,
    "",
    `Base URL: ${plan.baseUrl}  `,
    `Created: ${plan.createdAt}  `,
    ...(plan.followUpOf ? [`Follow-up of: ${plan.followUpOf}`] : []),
    "",
    plan.overview,
    "",
  ];
  for (const charter of plan.charters) {
    lines.push(
      `## ${charter.id} · ${charter.title} (${charter.priority} priority)`,
      "",
      `**Mission:** ${charter.mission}  `,
      `**Area:** ${charter.area}  `,
      `**Start:** ${charter.startUrl}  `,
      ...(charter.followsUp ? [`**Follows up:** ${charter.followsUp} from the earlier run  `] : []),
      `**Step budget:** ${charter.maxSteps}`,
      "",
      "Risks:",
      ...charter.risks.map((risk) => `- ${risk}`),
      "",
      "Techniques:",
      ...charter.techniques.map((technique) => `- ${technique}`),
      "",
    );
  }
  lines.push("---", "Edit plan.json to change charters, then rerun with --plan <path-to-plan.json>.");
  return lines.join("\n");
}
