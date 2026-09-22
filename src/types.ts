export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "functional",
  "validation",
  "error-handling",
  "ui-visual",
  "usability",
  "accessibility",
  "performance",
  "security",
  "content",
  "compatibility",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type FindingCategory = Category | "runtime-error" | "network-error";

export type Confidence = "high" | "medium" | "low";

export type SignalKind = "console-error" | "page-error" | "http-error" | "request-failed" | "blocked-request";

export interface Signal {
  kind: SignalKind;
  message: string;
  url?: string;
  status?: number;
  pageUrl: string;
  timestamp: string;
  sessionId?: string;
}

export interface Finding {
  id: string;
  sessionId: string;
  charterId: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  steps: string[];
  expected: string;
  actual: string;
  details?: string[];
  confidence: Confidence;
  reproduced: boolean;
  pageUrl: string;
  screenshots: string[];
  source: "agent" | "auto";
  occurrences?: number;
  pages?: string[];
  timestamp: string;
}

export interface Charter {
  id: string;
  title: string;
  mission: string;
  area: string;
  startUrl: string;
  risks: string[];
  techniques: string[];
  priority: "high" | "medium" | "low";
  maxSteps: number;
}

export interface TestPlan {
  client: string;
  baseUrl: string;
  createdAt: string;
  overview: string;
  charters: Charter[];
}

export interface ActionLogEntry {
  step: number;
  tool: string;
  args: string;
  pageUrl: string;
  ok: boolean;
  note?: string;
  timestamp: string;
}

export interface SessionResult {
  sessionId: string;
  charter: Charter;
  startedAt: string;
  endedAt: string;
  stepsUsed: number;
  stopReason: string;
  summary?: string;
  areasCovered: string[];
  areasNotCovered: string[];
  findings: Finding[];
  signals: Signal[];
  actionLog: ActionLogEntry[];
  costUsd: number;
  error?: string;
}

export interface Issue {
  id: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  needsVerification: boolean;
  triageNotes?: string[];
  primary: Finding;
  related: Finding[];
}
