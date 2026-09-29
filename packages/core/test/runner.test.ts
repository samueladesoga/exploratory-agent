import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defineTool, estimateSessionCostUsd, messagesApiRunner, resolveModel, text, usageCostUsd, type AgentRunOptions } from "../src/index.js";

type Response = Partial<Anthropic.Beta.BetaMessage> & { content: Anthropic.Beta.BetaContentBlock[] };

// A stand-in for the Anthropic client that replays scripted responses and records requests.
function fakeClient(responses: Response[]) {
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("no scripted response left");
          return {
            model: params.model,
            stop_reason: next.content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
            usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            ...next,
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Anthropic.Beta.BetaToolUseBlock;
const textBlock = (value: string) => ({ type: "text", text: value, citations: null }) as Anthropic.Beta.BetaTextBlock;

function options(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  const calls: string[] = [];
  return {
    name: "S01",
    systemPrompt: "system",
    prompt: "go",
    model: "sonnet",
    maxTurns: 10,
    log: () => {},
    tools: [
      defineTool("click", "Click", { target: z.string() }, async (args) => {
        calls.push(args.target);
        return { content: [{ type: "text", text: `clicked ${args.target}` }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }] };
      }),
      defineTool("explode", "Always fails", {}, async () => {
        throw new Error("boom");
      }),
    ],
    ...overrides,
  };
}

test("runs tools until the model stops, and sends results back in order", async () => {
  const { client, requests } = fakeClient([
    { content: [toolUse("t1", "click", { target: "Save" }), toolUse("t2", "click", { target: 42 }), toolUse("t3", "explode", {})] },
    { content: [textBlock("All done.")] },
  ]);
  const progress: number[] = [];
  const run = await messagesApiRunner({ client }).run(options({ onTurn: (p) => progress.push(p.turns) }));

  assert.deepEqual({ stop: run.stopReason, turns: run.turns, text: run.resultText }, { stop: "success", turns: 2, text: "All done." });
  assert.deepEqual(progress, [1, 2]);
  assert.equal(requests[0].model, "claude-sonnet-5");
  assert.deepEqual(requests[0].cache_control, { type: "ephemeral" });
  assert.equal(requests[0].tools!.length, 2);
  assert.deepEqual((requests[0].tools![0] as Anthropic.Beta.BetaTool).input_schema.required, ["target"]);
  assert.equal("$schema" in (requests[0].tools![0] as Anthropic.Beta.BetaTool).input_schema, false);

  const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.deepEqual(results.map((result) => [result.tool_use_id, result.is_error ?? false]), [["t1", false], ["t2", true], ["t3", true]]);
  assert.deepEqual((results[0].content as Anthropic.Beta.BetaImageBlockParam[])[1].source, { type: "base64", media_type: "image/jpeg", data: "AAAA" });
  assert.match(results[1].content as string, /Invalid input for click/);
  assert.equal(results[2].content, "explode failed: boom");
});

test("opus requests opt into server-side refusal fallbacks", async () => {
  const { client, requests } = fakeClient([{ content: [textBlock("hi")] }]);
  await messagesApiRunner({ client }).run(options({ model: "opus" }));
  assert.equal(requests[0].model, "claude-opus-5");
  assert.deepEqual(requests[0].betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(requests[0].fallbacks, "default");
});

test("stops at the turn limit, the budget, and on abort", async () => {
  const loop = () => ({ content: [toolUse("t", "click", { target: "x" })] });

  const turns = await messagesApiRunner({ client: fakeClient([loop(), loop(), loop()]).client }).run(options({ maxTurns: 2 }));
  assert.deepEqual([turns.stopReason, turns.turns], ["error_max_turns", 2]);

  // Each fake turn costs 1000 input + 100 output tokens on Sonnet = $0.003.
  const budget = await messagesApiRunner({ client: fakeClient([loop(), loop(), loop()]).client }).run(options({ maxBudgetUsd: 0.005 }));
  assert.deepEqual([budget.stopReason, budget.turns], ["error_max_budget_usd", 2]);
  assert.ok(Math.abs(budget.costUsd - 0.006) < 1e-9);

  const controller = new AbortController();
  controller.abort();
  const aborted = await messagesApiRunner({ client: fakeClient([loop()]).client }).run(options({ signal: controller.signal }));
  assert.deepEqual([aborted.stopReason, aborted.turns], ["aborted", 0]);
});

test("model aliases resolve to ids and prices; unknown ids are priced like Opus", () => {
  assert.equal(resolveModel("SONNET").id, "claude-sonnet-5");
  assert.equal(resolveModel("claude-haiku-4-5").label, "Claude Haiku 4.5");
  assert.equal(resolveModel("claude-future-9").inputPerMTok, 5);
  const cost = usageCostUsd(resolveModel("opus"), { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
  assert.equal(cost, 5 + 6.25 + 0.5);
  const quick = estimateSessionCostUsd("sonnet", 25, 12000);
  assert.ok(quick > 0.05 && quick < 1, `quick-mode estimate ${quick}`);
  assert.ok(estimateSessionCostUsd("opus", 25, 12000) > quick);
  assert.equal(text("x").content[0].type, "text");
});
