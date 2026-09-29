import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentRun, AgentRunner, AgentRunOptions, AnyToolDef, ToolResult } from "./agent.js";
import { resolveModel, usageCostUsd } from "./models.js";
import { errMsg, truncate } from "./util.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

export interface MessagesRunnerOptions {
  apiKey?: string;
  // Needed when running in a browser (the extension): the key is the user's own and stays on their machine.
  browser?: boolean;
  // Injected in tests.
  client?: Anthropic;
  maxTokens?: number;
}

// Runs agents with a manual tool-use loop on the Messages API. Used by the extension, where the
// Claude Agent SDK can't run. Enforces the same limits the Agent SDK does: turns, a USD budget
// computed from token usage, a timeout, and an abort signal.
export function messagesApiRunner(opts: MessagesRunnerOptions): AgentRunner {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: opts.browser ?? false, maxRetries: 4 });
  return { run: (options) => runLoop(client, options, opts.maxTokens ?? 16_000) };
}

// Checks a key with a cheap Models API call. Returns undefined when it works, or a message to show.
export async function validateApiKey(apiKey: string, opts: { browser?: boolean; client?: Anthropic } = {}): Promise<string | undefined> {
  const client = opts.client ?? new Anthropic({ apiKey, dangerouslyAllowBrowser: opts.browser ?? false, maxRetries: 1 });
  try {
    await client.models.list({ limit: 1 });
    return undefined;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return "That key was rejected. Check it was copied in full from console.anthropic.com.";
    if (err instanceof Anthropic.PermissionDeniedError) return "That key doesn't have permission to use the API.";
    if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) return `Anthropic's API is having problems right now (HTTP ${err.status}). The key was saved; try again in a moment.`;
    if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach api.anthropic.com. Check your connection.";
    return errMsg(err);
  }
}

function toApiTool(def: AnyToolDef): Anthropic.Beta.BetaTool {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(z.object(def.shape)) as Record<string, unknown>;
  return { name: def.name, description: def.description, input_schema: schema as Anthropic.Beta.BetaTool.InputSchema };
}

function toApiContent(result: ToolResult): ToolResultBlock["content"] {
  return result.content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, source: { type: "base64" as const, media_type: part.mimeType as "image/jpeg", data: part.data } },
  );
}

async function runTool(def: AnyToolDef | undefined, block: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResultBlock> {
  const fail = (message: string): ToolResultBlock => ({ type: "tool_result", tool_use_id: block.id, is_error: true, content: message });
  if (!def) return fail(`Unknown tool ${block.name}.`);
  const parsed = z.object(def.shape).safeParse(block.input);
  if (!parsed.success) return fail(`Invalid input for ${block.name}: ${z.prettifyError(parsed.error)}`);
  try {
    return { type: "tool_result", tool_use_id: block.id, content: toApiContent(await def.handler(parsed.data)) };
  } catch (err) {
    return fail(`${block.name} failed: ${errMsg(err)}`);
  }
}

async function runLoop(client: Anthropic, options: AgentRunOptions, maxTokens: number): Promise<AgentRun> {
  const model = resolveModel(options.model);
  const tools = options.tools.map(toApiTool);
  const toolsByName = new Map(options.tools.map((def) => [def.name, def]));
  const messages: MessageParam[] = [{ role: "user", content: options.prompt }];

  const abort = new AbortController();
  const onExternalAbort = () => abort.abort("aborted");
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener("abort", onExternalAbort);
  const timer = options.timeoutMinutes ? setTimeout(() => abort.abort("timeout"), options.timeoutMinutes * 60_000) : undefined;

  let costUsd = 0;
  let turns = 0;
  let stopReason = "error_max_turns";
  let resultText: string | undefined;

  try {
    while (turns < options.maxTurns) {
      if (abort.signal.aborted) {
        stopReason = String(abort.signal.reason ?? "aborted");
        break;
      }
      if (options.maxBudgetUsd !== undefined && costUsd >= options.maxBudgetUsd) {
        stopReason = "error_max_budget_usd";
        break;
      }

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create(
          {
            model: model.id,
            max_tokens: maxTokens,
            system: options.systemPrompt,
            tools,
            messages,
            // Caches everything up to the latest message, so each turn only pays full price for what's new.
            cache_control: { type: "ephemeral" },
            ...(model.supportsRefusalFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: abort.signal },
        );
      } catch (err) {
        if (abort.signal.aborted) {
          stopReason = String(abort.signal.reason ?? "aborted");
          break;
        }
        throw err;
      }

      turns += 1;
      costUsd += usageCostUsd(resolveModel(response.model), response.usage);
      options.onTurn?.({ turns, costUsd });
      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "tool_use") {
          options.log(`${options.name} → ${block.name} ${truncate(JSON.stringify(block.input), 140)}`);
        } else if (block.type === "text" && options.verbose && block.text.trim()) {
          options.log(`${options.name} 💭 ${truncate(block.text.trim().replace(/\s+/g, " "), 200)}`);
        }
      }

      if (response.stop_reason === "refusal") {
        stopReason = "refusal";
        break;
      }
      if (response.stop_reason === "pause_turn") continue;
      const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
      if (!toolUses.length) {
        stopReason = "success";
        resultText = response.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        break;
      }
      if (response.stop_reason === "max_tokens") {
        stopReason = "error_max_tokens";
        break;
      }

      // Browser actions depend on each other, so tools run one at a time, in order.
      const results: ToolResultBlock[] = [];
      for (const block of toolUses) {
        const result = await runTool(toolsByName.get(block.name), block);
        if (result.is_error) options.log(`${options.name} ✖ ${truncate(String(result.content), 200)}`);
        results.push(result);
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }

  return { stopReason, resultText, costUsd, turns };
}
