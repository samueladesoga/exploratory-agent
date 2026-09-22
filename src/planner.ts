import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runAgent } from "./agent.js";
import { appOrigins, type ClientConfig } from "./config.js";
import { PLANNER_SYSTEM, plannerPrompt } from "./prompts.js";
import type { Charter, TestPlan } from "./types.js";
import { text, type Logger } from "./util.js";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export async function createPlan(
  cfg: ClientConfig,
  siteMap: string,
  opts: { cwd: string; log: Logger },
): Promise<{ plan: TestPlan; costUsd: number }> {
  let plan: TestPlan | undefined;
  const origins = appOrigins(cfg);

  const submitPlan = tool(
    "submit_plan",
    "Submit the finished exploratory test plan.",
    {
      overview: z.string().describe("2-4 sentences: overall test strategy and the main risks"),
      charters: z
        .array(
          z.object({
            title: z.string(),
            mission: z.string().describe("Explore <target> with <resources> to discover <information>"),
            area: z.string(),
            start_path: z.string().describe("Path or absolute URL within the app where the session starts"),
            risks: z.array(z.string()),
            techniques: z.array(z.string()),
            priority: z.enum(["high", "medium", "low"]),
          }),
        )
        .min(1),
    },
    async (submission) => {
      const charters: Charter[] = submission.charters
        .map((charterInput) => {
          let startUrl = cfg.baseUrl;
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
          };
        })
        .sort((charterA, charterB) => PRIORITY_ORDER[charterA.priority] - PRIORITY_ORDER[charterB.priority])
        .map((charter, index) => ({ ...charter, id: `C${String(index + 1).padStart(2, "0")}` }));

      plan = {
        client: cfg.name,
        baseUrl: cfg.baseUrl,
        createdAt: new Date().toISOString(),
        overview: submission.overview,
        charters,
      };
      return text(`Plan received with ${charters.length} charters. You are done.`);
    },
  );

  const run = await runAgent({
    name: "planner",
    systemPrompt: PLANNER_SYSTEM,
    prompt: plannerPrompt(cfg, siteMap),
    server: createSdkMcpServer({ name: "qa", version: "1.0.0", tools: [submitPlan] }),
    toolNames: ["submit_plan"],
    model: cfg.run.plannerModel,
    maxTurns: 4,
    cwd: opts.cwd,
    log: opts.log,
  });

  if (!plan) throw new Error(`Planner finished without submitting a plan (stop reason: ${run.stopReason}).`);
  return { plan, costUsd: run.costUsd };
}

export function planToMarkdown(plan: TestPlan): string {
  const lines = [
    `# Exploratory test plan: ${plan.client}`,
    "",
    `Base URL: ${plan.baseUrl}  `,
    `Created: ${plan.createdAt}`,
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
