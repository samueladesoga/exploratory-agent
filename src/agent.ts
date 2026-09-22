import { query, type McpSdkServerConfigWithInstance, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { truncate, type Logger } from "./util.js";

const SERVER_KEY = "qa";

export interface AgentRunOptions {
  name: string;
  systemPrompt: string;
  prompt: string;
  server: McpSdkServerConfigWithInstance;
  toolNames: string[];
  model: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  timeoutMinutes?: number;
  cwd: string;
  log: Logger;
  verbose?: boolean;
}

export interface AgentRun {
  stopReason: string;
  resultText?: string;
  costUsd: number;
  turns: number;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRun> {
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: options.prompt },
      parent_tool_use_id: null,
    };
  }

  const abortController = new AbortController();
  const timer = options.timeoutMinutes
    ? setTimeout(() => abortController.abort(), options.timeoutMinutes * 60_000)
    : undefined;
  const toolPrefix = `mcp__${SERVER_KEY}__`;
  let run: AgentRun = { stopReason: "no_result", costUsd: 0, turns: 0 };

  try {
    const stream = query({
      prompt: input(),
      options: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        mcpServers: { [SERVER_KEY]: options.server },
        strictMcpConfig: true,
        tools: [],
        allowedTools: options.toolNames.map((toolName) => toolPrefix + toolName),
        canUseTool: async () => ({ behavior: "deny", message: "Only the provided testing tools are permitted." }),
        settingSources: [],
        persistSession: false,
        cwd: options.cwd,
        abortController,
      },
    });

    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            options.log(`${options.name} → ${block.name.replace(toolPrefix, "")} ${truncate(JSON.stringify(block.input), 140)}`);
          } else if (block.type === "text" && options.verbose && block.text.trim()) {
            options.log(`${options.name} 💭 ${truncate(block.text.trim().replace(/\s+/g, " "), 200)}`);
          }
        }
      } else if (message.type === "result") {
        run = {
          stopReason: message.subtype,
          resultText: message.subtype === "success" ? message.result : undefined,
          costUsd: message.total_cost_usd,
          turns: message.num_turns,
        };
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) run = { ...run, stopReason: "timeout" };
    else throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return run;
}
