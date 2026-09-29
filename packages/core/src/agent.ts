import type { z } from "zod";
import type { Logger } from "./util.js";

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// A type alias rather than an interface so it stays assignable to MCP's CallToolResult.
export type ToolResult = {
  content: ToolContent[];
};

// A tool the model can call. Defined once here and adapted by each runner: the CLI hands it to the
// Claude Agent SDK as an in-process MCP tool, the extension turns the zod shape into a JSON schema
// for the Messages API.
export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>;
}

export type AnyToolDef = ToolDef<any>;

export function defineTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
): ToolDef<Shape> {
  return { name, description, shape, handler };
}

export interface AgentRunOptions {
  name: string;
  systemPrompt: string;
  prompt: string;
  tools: AnyToolDef[];
  model: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  timeoutMinutes?: number;
  log: Logger;
  verbose?: boolean;
}

export interface AgentRun {
  stopReason: string;
  resultText?: string;
  costUsd: number;
  turns: number;
}

export interface AgentRunner {
  run(options: AgentRunOptions): Promise<AgentRun>;
}
