import { parse, stringify } from "yaml";
import { z } from "zod";

const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("form"),
    loginUrl: z.url(),
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
    usernameEnv: z.string(),
    passwordEnv: z.string(),
    successSelector: z.string().optional(),
  }),
  z.object({
    type: z.literal("storageState"),
    path: z.string(),
  }),
]);

export const ClientConfigSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.url(),
  description: z.string().min(1),
  focusAreas: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  knownIssues: z.array(z.string()).default([]),
  testData: z.record(z.string(), z.string()).default({}),
  seedPaths: z.array(z.string()).default([]),
  allowedOrigins: z.array(z.url()).default([]),
  auth: AuthSchema.default({ type: "none" }),
  safety: z
    .object({
      blockMutations: z.boolean().default(false),
      blockedRequests: z
        .array(z.object({ method: z.string().optional(), urlPattern: z.string() }))
        .default([{ urlPattern: "log-?out|sign-?out" }]),
      ignoreSignals: z.array(z.string()).default([]),
    })
    .prefault({}),
  run: z
    .object({
      sessions: z.number().int().min(1).max(30).default(5),
      maxStepsPerSession: z.number().int().min(10).max(300).default(60),
      maxMinutesPerSession: z.number().min(1).default(20),
      maxBudgetUsdPerSession: z.number().positive().optional(),
      concurrency: z.number().int().min(1).max(5).default(1),
      plannerModel: z.string().default("opus"),
      explorerModel: z.string().default("sonnet"),
      reconMaxPages: z.number().int().min(1).max(100).default(15),
      snapshotMaxChars: z.number().int().min(2000).default(12000),
    })
    .prefault({}),
  browser: z
    .object({
      headless: z.boolean().default(true),
      viewport: z.object({ width: z.number().int(), height: z.number().int() }).default({ width: 1366, height: 900 }),
      ignoreHttpsErrors: z.boolean().default(false),
      actionTimeoutMs: z.number().int().default(10_000),
      navigationTimeoutMs: z.number().int().default(30_000),
      acceptDialogs: z.boolean().default(false),
    })
    .prefault({}),
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// `source` names where the config came from (a file path, "side panel"…) for error messages.
export function parseClientConfig(raw: unknown, source: string): ClientConfig {
  const result = ClientConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
    throw new Error(`Invalid client config ${source}:\n${problems}`);
  }
  return result.data;
}

export function parseClientConfigYaml(yamlText: string, source: string): ClientConfig {
  return parseClientConfig(parse(yamlText), source);
}

// A client YAML the CLI can run, e.g. exported from the extension. Login isn't exported: the
// extension uses the browser's own session, so the CLI user adds auth themselves.
export function clientConfigToYaml(cfg: ClientConfig): string {
  const { auth, browser: _browser, ...rest } = cfg;
  const header = [
    `# Exported client config for ${cfg.name}.`,
    "# Run it with: npm run explore -- --client clients/<file>.yaml",
    auth.type === "none" ? "# If the app needs a login, add an auth section (see clients/_template.yaml)." : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = auth.type === "none" ? rest : { ...rest, auth };
  return `${header}\n${stringify(body, { lineWidth: 0 })}`;
}

export function appOrigins(cfg: ClientConfig): Set<string> {
  const origins = new Set<string>([new URL(cfg.baseUrl).origin]);
  for (const origin of cfg.allowedOrigins) origins.add(new URL(origin).origin);
  if (cfg.auth.type === "form") origins.add(new URL(cfg.auth.loginUrl).origin);
  return origins;
}
