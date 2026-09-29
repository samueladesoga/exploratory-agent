import { createSdkMcpServer, query, tool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { truncate, type AgentRun, type AgentRunner, type AgentRunOptions } from "@exploratory-agent/core";

const SERVER_KEY = "qa";

// Runs agents through the Claude Agent SDK, exposing the core tools as an in-process MCP server.
// `cwd` is the run directory, used as the agent's working directory.
export function sdkRunner(cwd: string): AgentRunner {
  return { run: (options) => runAgent(options, cwd) };
}

async function runAgent(options: AgentRunOptions, cwd: string): Promise<AgentRun> {
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
  const server = createSdkMcpServer({
    name: SERVER_KEY,
    version: "1.0.0",
    tools: options.tools.map((def) => tool(def.name, def.description, def.shape, (args) => def.handler(args))),
  });
  let run: AgentRun = { stopReason: "no_result", costUsd: 0, turns: 0 };

  try {
    const stream = query({
      prompt: input(),
      options: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        mcpServers: { [SERVER_KEY]: server },
        strictMcpConfig: true,
        tools: [],
        allowedTools: options.tools.map((def) => toolPrefix + def.name),
        canUseTool: async () => ({ behavior: "deny", message: "Only the provided testing tools are permitted." }),
        settingSources: [],
        persistSession: false,
        cwd,
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
