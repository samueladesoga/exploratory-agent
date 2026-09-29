// User settings in chrome.storage.local. The API key never leaves this browser except in requests
// to api.anthropic.com. chrome.storage.local is not encrypted, and the UI says so.

export type Role = "developer" | "qa";
export type ModelPreset = "balanced" | "budget" | "thorough";

export interface Settings {
  apiKey: string;
  role?: Role;
  preset: ModelPreset;
  // Hard cap per session, in USD.
  sessionCapUsd: number;
  // Origins the user confirmed they own or may test.
  authorizedOrigins: string[];
}

export const DEFAULT_SETTINGS: Settings = { apiKey: "", preset: "balanced", sessionCapUsd: 1, authorizedOrigins: [] };

// Planner/triage model and explorer model for each preset.
export const PRESETS: Record<ModelPreset, { label: string; description: string; plannerModel: string; explorerModel: string }> = {
  balanced: { label: "Balanced", description: "Opus plans and triages, Sonnet explores. Same as the CLI.", plannerModel: "opus", explorerModel: "sonnet" },
  budget: { label: "Budget", description: "Sonnet plans and triages, Haiku explores. Cheapest.", plannerModel: "sonnet", explorerModel: "haiku" },
  thorough: { label: "Thorough", description: "Opus throughout. Most careful, most expensive.", plannerModel: "opus", explorerModel: "opus" },
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get("settings")).settings as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
