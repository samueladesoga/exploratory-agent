import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientConfigToYaml,
  executePlan,
  issueToMarkdown,
  parseClientConfigYaml,
  quickPlan,
  type AgentRunner,
  type ActionLogEntry,
  type Finding,
  type RunContext,
} from "../src/index.js";
import { FakeDriver, makeConfig, makeFinding } from "./fixtures.js";

test("exported YAML round-trips through the CLI's parser", () => {
  const cfg = makeConfig({ focusAreas: ["Checkout"], testData: { email: "qa@example.com" }, safety: { blockMutations: true }, run: { sessions: 2 } });
  const yaml = clientConfigToYaml(cfg);
  assert.match(yaml, /^# Exported client config for Acme\./);
  assert.match(yaml, /add an auth section/);
  assert.doesNotMatch(yaml, /^browser:/m);
  const { browser: _a, ...roundTripped } = parseClientConfigYaml(yaml, "export");
  const { browser: _b, ...original } = cfg;
  assert.deepEqual(roundTripped, original);
});

test("quick plan is one high-priority charter on the current page", () => {
  const plan = quickPlan(makeConfig({ run: { maxStepsPerSession: 25 } }), "https://app.example.com/cart?x=1", "  ");
  assert.equal(plan.charters.length, 1);
  assert.equal(plan.charters[0].startUrl, "https://app.example.com/cart?x=1");
  assert.equal(plan.charters[0].title, "Quick check: /cart");
  assert.equal(plan.charters[0].maxSteps, 25);
});

test("issueToMarkdown makes a tracker-ready body", () => {
  const body = issueToMarkdown({
    id: "BUG-001",
    title: "t",
    severity: "high",
    category: "functional",
    needsVerification: true,
    triageNotes: ["Seen once"],
    primary: makeFinding({ details: ["Also on mobile"] }),
    related: [],
  });
  assert.match(body, /^\*\*Severity:\*\* high · \*\*Category:\*\* functional · needs verification/);
  assert.match(body, /1\. Open \/cart\n2\. Set quantity to -3/);
  assert.match(body, /- Also on mobile/);
  assert.match(body, /### Notes\n\n- Seen once/);
});

test("executePlan runs sessions, reports progress, triages and totals cost", async () => {
  const actions: ActionLogEntry[] = [];
  const findings: Finding[] = [];
  const written: string[] = [];
  // The runner plays the explorer: one click, one finding, then ends. Triage fails to submit.
  const runner: AgentRunner = {
    async run(opts) {
      const tools = Object.fromEntries(opts.tools.map((tool) => [tool.name, tool]));
      if (tools.click) {
        await tools.click.handler({ target: "Save" });
        await tools.record_finding.handler({ title: "Broken", severity: "medium", category: "functional", steps: ["a"], expected: "b", actual: "c", confidence: "high", reproduced: true });
        await tools.end_session.handler({ summary: "Done", areas_covered: [], areas_not_covered: [] });
      }
      opts.onTurn?.({ turns: 1, costUsd: 0.25 });
      return { stopReason: "success", costUsd: 0.25, turns: 1 };
    },
  };
  const costs: string[] = [];
  const ctx: RunContext = {
    runner,
    storage: { write: async (file) => void written.push(file) },
    createDriver: () => new FakeDriver(),
    log: () => {},
    observer: { action: (_id, entry) => actions.push(entry), finding: (finding) => findings.push(finding), cost: (name) => costs.push(name) },
  };
  const cfg = makeConfig();
  const plan = quickPlan(cfg, "https://app.example.com/", "Home");
  const report = await executePlan(cfg, plan, plan.charters, ctx, { priorCostUsd: 1 });

  assert.equal(report.sessions[0].stopReason, "completed");
  assert.deepEqual(actions.map((action) => action.tool), ["click"]);
  assert.equal(findings[0].id, "S01-F01");
  assert.deepEqual(costs, ["S01", "triage"]);
  assert.equal(report.issues[0].id, "BUG-001");
  assert.equal(report.totalCostUsd, 1.5);
  assert.deepEqual(written, ["sessions/S01.json"]);
});
