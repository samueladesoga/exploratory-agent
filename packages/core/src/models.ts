// Model aliases used in client configs ("opus", "sonnet", "haiku") and their Messages API ids and
// prices. The CLI passes aliases straight to the Claude Agent SDK, which resolves them itself; the
// extension's Messages API runner resolves them here. Prices are USD per million tokens.
export interface ModelInfo {
  id: string;
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  // Cache writes cost 1.25x input and cache reads 0.1x input.
  supportsRefusalFallback: boolean;
}

export const MODELS: Record<string, ModelInfo> = {
  opus: { id: "claude-opus-5", label: "Claude Opus 5", inputPerMTok: 5, outputPerMTok: 25, supportsRefusalFallback: true },
  sonnet: { id: "claude-sonnet-5", label: "Claude Sonnet 5", inputPerMTok: 2, outputPerMTok: 10, supportsRefusalFallback: false },
  haiku: { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", inputPerMTok: 1, outputPerMTok: 5, supportsRefusalFallback: false },
};

// Accepts an alias or a full model id. Unknown ids are priced like Opus so cost caps err on the safe side.
export function resolveModel(nameOrId: string): ModelInfo {
  const alias = MODELS[nameOrId.toLowerCase()];
  if (alias) return alias;
  const known = Object.values(MODELS).find((model) => model.id === nameOrId);
  return known ?? { ...MODELS.opus, id: nameOrId, label: nameOrId, supportsRefusalFallback: false };
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function usageCostUsd(model: ModelInfo, usage: TokenUsage): number {
  const perToken = model.inputPerMTok / 1_000_000;
  return (
    usage.input_tokens * perToken +
    (usage.cache_creation_input_tokens ?? 0) * perToken * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * perToken * 0.1 +
    usage.output_tokens * (model.outputPerMTok / 1_000_000)
  );
}

// Rough pre-run estimate, shown before a run starts. Each step re-sends the conversation, mostly
// from cache, plus a fresh snapshot and a short model turn. Calibrated against CLI runs, where
// snapshots averaged about 40% of snapshotMaxChars and sessions cost ~$0.012 a step at $3/$15.
export function estimateSessionCostUsd(modelName: string, steps: number, snapshotMaxChars: number): number {
  const model = resolveModel(modelName);
  const snapshotTokens = (snapshotMaxChars / 4) * 0.4;
  const perStepUncached = snapshotTokens * 1.25 + 400; // new snapshot written to cache, plus tool-call overhead
  const averageHistoryTokens = 6_000 + (steps / 2) * snapshotTokens; // cached prefix read each step
  const inputTokens = steps * (perStepUncached + averageHistoryTokens * 0.1);
  const outputTokens = steps * 200;
  return (inputTokens * model.inputPerMTok + outputTokens * model.outputPerMTok) / 1_000_000;
}
