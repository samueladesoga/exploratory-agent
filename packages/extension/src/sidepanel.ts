import {
  clientConfigToYaml,
  estimateSessionCostUsd,
  issueToMarkdown,
  parseClientConfig,
  parseClientConfigYaml,
  validateApiKey,
  type ActionLogEntry,
  type Charter,
  type ClientConfig,
  type Finding,
  type Issue,
  type RunReport,
} from "@exploratory-agent/core";
import { deleteRun, getFile, listRuns, type RunRecord } from "./db.js";
import { DEMO_CONFIG, demoLogin, startExecution, startPlanning, startQuickRun, type ActiveRun, type PlannedRun } from "./runs.js";
import { loadSettings, PRESETS, saveSettings, type ModelPreset, type Role, type Settings } from "./settings.js";
import { TEMPLATES } from "./templates.js";
import { copy, download, h, lines, pairs, timeAgo, usd } from "./ui.js";

const QUICK_STEPS = 25;
const SNAPSHOT_CHARS = 12_000;
const PLANNING_ESTIMATE_USD = 0.15;
const TRIAGE_ESTIMATE_USD = 0.1;

type Tab = { url: string; title: string; origin: string } | undefined;

let settings: Settings;
let currentTab: Tab;
let activeRun: ActiveRun | undefined;
let windowId: number | undefined;
let render: () => void = () => {};

const app = document.getElementById("app")!;

function show(...children: Parameters<typeof h>[2][]): void {
  app.replaceChildren(...h("div", {}, ...children).childNodes);
  window.scrollTo(0, 0);
}

// ---- shared pieces -----------------------------------------------------------------------------

function nav(active: "test" | "history" | "settings"): HTMLElement {
  const item = (id: typeof active, label: string, go: () => void) =>
    h("button", { class: `nav-item${active === id ? " active" : ""}`, onclick: go, "aria-current": active === id ? "page" : undefined }, label);
  return h("nav", { class: "nav" }, item("test", "Test", showHome), item("history", "History", showHistory), item("settings", "Settings", showSettings));
}

function notice(text: string, kind: "info" | "warn" | "error" = "info"): HTMLElement {
  return h("p", { class: `notice ${kind}`, role: kind === "error" ? "alert" : undefined }, text);
}

function severityBadge(severity: string): HTMLElement {
  return h("span", { class: `sev sev-${severity}` }, severity);
}

function modelsFor(preset: ModelPreset) {
  return PRESETS[preset];
}

// sidepanel.html?tab=<id> pins the panel to one tab, for opening it as a normal tab (tests, debugging).
const pinnedTabId = Number(new URLSearchParams(location.search).get("tab")) || undefined;

async function refreshTab(): Promise<void> {
  const [tab] = pinnedTabId ? [await chrome.tabs.get(pinnedTabId).catch(() => undefined)] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.url?.startsWith("http")) currentTab = { url: tab.url, title: tab.title ?? "", origin: new URL(tab.url).origin };
  else currentTab = undefined;
}

function authorizationCheckbox(origin: string): { el: HTMLElement; ok: () => boolean } {
  const already = settings.authorizedOrigins.includes(origin);
  const box = h("input", { type: "checkbox", id: "authorize", checked: already });
  return {
    el: already ? h("span") : h("label", { class: "check", for: "authorize" }, box, `I own ${origin} or have permission to test it.`),
    ok: () => box.checked,
  };
}

async function rememberAuthorization(origin: string): Promise<void> {
  if (!settings.authorizedOrigins.includes(origin)) settings = await saveSettings({ authorizedOrigins: [...settings.authorizedOrigins, origin] });
}

function readOnlyToggle(): { el: HTMLElement; value: () => boolean } {
  const box = h("input", { type: "checkbox", id: "read-only", checked: true });
  return {
    el: h(
      "label",
      { class: "check", for: "read-only" },
      box,
      h("span", {}, h("strong", {}, "Read-only"), " · blocks form submissions and other changes. Untick only on test environments."),
    ),
    value: () => box.checked,
  };
}

// ---- onboarding ----------------------------------------------------------------------------------

function showOnboarding(): void {
  const key = h("input", { type: "password", id: "api-key", placeholder: "sk-ant-…", autocomplete: "off", value: settings.apiKey });
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const save = h("button", { class: "primary" }, "Save key");
  save.addEventListener("click", async () => {
    const value = key.value.trim();
    if (!value) return void (status.textContent = "Paste your API key first.");
    save.disabled = true;
    status.textContent = "Checking the key…";
    const problem = await validateApiKey(value, { browser: true });
    save.disabled = false;
    if (problem && !problem.includes("having problems")) return void (status.textContent = problem);
    settings = await saveSettings({ apiKey: value });
    if (problem) status.textContent = problem;
    showRoleChoice();
  });

  show(
    h("header", { class: "hero" }, h("h1", {}, "Exploratory Agent"), h("p", {}, "An AI tester that explores the site you're on and reports the bugs it finds.")),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "1. Add your Anthropic API key"),
      h("p", { class: "muted" }, "Runs are billed to your own key. A quick check usually costs a few cents."),
      h("label", { for: "api-key" }, "API key"),
      key,
      save,
      status,
      h("p", { class: "fine" }, "Get a key at ", h("a", { href: "https://console.anthropic.com/settings/keys", target: "_blank" }, "console.anthropic.com"), ". It's stored only in this browser (chrome.storage.local, which is not encrypted) and is only ever sent to api.anthropic.com."),
    ),
  );
}

function showRoleChoice(): void {
  const choose = async (role: Role) => {
    settings = await saveSettings({ role });
    showHome();
  };
  show(
    h("header", { class: "hero" }, h("h1", {}, "How will you use it?"), h("p", {}, "This sets what you see first. You can switch anytime in Settings.")),
    h(
      "button",
      { class: "choice", onclick: () => choose("developer") },
      h("strong", {}, "I'm mainly a developer or founder"),
      h("span", {}, "One-click checks of the page you're on. Summary first."),
    ),
    h(
      "button",
      { class: "choice", onclick: () => choose("qa") },
      h("strong", {}, "I'm mainly a QA tester"),
      h("span", {}, "Planned sessions with charters you review, full reports and CSV export."),
    ),
  );
}

// ---- home ----------------------------------------------------------------------------------------

async function showHome(): Promise<void> {
  render = showHome;
  if (activeRun) return;
  await refreshTab();
  const demo = h("button", { class: "link", onclick: runDemo }, "Try it on a demo shop");

  if (!currentTab) {
    show(nav("test"), h("section", { class: "card" }, h("h2", {}, "Open a website to test it"), h("p", { class: "muted" }, "Go to the site you want to test, then come back here."), demo));
    return;
  }

  const tab = currentTab;
  const auth = authorizationCheckbox(tab.origin);
  const readOnly = readOnlyToggle();
  const description = h("textarea", { id: "quick-description", rows: 3, placeholder: "e.g. Checkout page. Shipping is free over £50 and VAT is 20%." });
  const models = modelsFor(settings.preset);
  const estimate = estimateSessionCostUsd(models.explorerModel, QUICK_STEPS, SNAPSHOT_CHARS) + TRIAGE_ESTIMATE_USD / 2;
  const error = h("div");

  const quick = h(
    "section",
    { class: "card" },
    h("h2", {}, "Find bugs on this page"),
    h("p", { class: "muted" }, `One ${QUICK_STEPS}-step session starting here. About 2–4 minutes.`),
    h("label", { for: "quick-description" }, "What should this page do? ", h("span", { class: "muted" }, "(optional, but it helps the agent spot wrong behaviour)")),
    description,
    readOnly.el,
    h("p", { class: "estimate" }, `About ${usd(estimate)} · capped at ${usd(settings.sessionCapUsd)}`),
    h(
      "button",
      {
        class: "primary",
        onclick: async () => {
          if (!auth.ok()) return void error.replaceChildren(notice("Confirm you're allowed to test this site first.", "warn"));
          await rememberAuthorization(tab.origin);
          const cfg = quickConfig(tab, description.value, readOnly.value());
          runQuick(cfg, tab.url, tab.title);
        },
      },
      "Find bugs",
    ),
  );

  const full = h(
    "section",
    { class: "card" },
    h("h2", {}, "Plan a session"),
    h("p", { class: "muted" }, "Map the site, review test charters, then run several sessions and get a full report."),
    h(
      "button",
      {
        class: settings.role === "qa" ? "primary" : "secondary",
        onclick: async () => {
          if (!auth.ok()) return void error.replaceChildren(notice("Confirm you're allowed to test this site first.", "warn"));
          await rememberAuthorization(tab.origin);
          showFullSetup(tab);
        },
      },
      "Plan a session",
    ),
  );

  show(
    nav("test"),
    h("div", { class: "site" }, h("span", { class: "muted" }, "Testing"), h("strong", {}, tab.origin), h("span", { class: "muted truncate" }, tab.title)),
    auth.el,
    error,
    ...(settings.role === "qa" ? [full, quick] : [quick, full]),
    h("p", { class: "center" }, demo),
  );
}

function quickConfig(tab: NonNullable<Tab>, description: string, readOnly: boolean): ClientConfig {
  const models = modelsFor(settings.preset);
  return parseClientConfig(
    {
      name: new URL(tab.url).hostname,
      baseUrl: `${tab.origin}/`,
      description:
        description.trim() ||
        `The page "${tab.title}" at ${tab.url}. No description was given, so judge correct behaviour from what the page itself says and from common sense.`,
      safety: { blockMutations: readOnly },
      run: {
        sessions: 1,
        maxStepsPerSession: QUICK_STEPS,
        maxBudgetUsdPerSession: settings.sessionCapUsd,
        // One session needs little triage, so the cheaper model does it.
        plannerModel: models.explorerModel,
        explorerModel: models.explorerModel,
        snapshotMaxChars: SNAPSHOT_CHARS,
      },
    },
    "side panel",
  );
}

async function runDemo(): Promise<void> {
  const models = modelsFor(settings.preset);
  const cfg = parseClientConfig(
    { ...DEMO_CONFIG, run: { sessions: 1, maxStepsPerSession: QUICK_STEPS, maxBudgetUsdPerSession: settings.sessionCapUsd, plannerModel: models.explorerModel, explorerModel: models.explorerModel } },
    "demo",
  );
  show(nav("test"), h("section", { class: "card" }, h("h2", {}, "Logging in to the demo shop…"), h("p", { class: "muted" }, "saucedemo.com is a public practice site with deliberate bugs.")));
  try {
    await demoLogin(cfg, windowId);
    runQuick(cfg, "https://www.saucedemo.com/inventory.html", "Swag Labs products");
  } catch (err) {
    show(nav("test"), notice(`The demo couldn't start: ${err instanceof Error ? err.message : String(err)}`, "error"));
  }
}

// ---- full mode setup -----------------------------------------------------------------------------

function showFullSetup(tab: NonNullable<Tab>, preset?: Partial<ClientConfig>): void {
  render = () => {};
  const field = (id: string, label: string, input: HTMLElement, hint?: string) => h("div", { class: "field" }, h("label", { for: id }, label, hint ? h("span", { class: "muted" }, ` ${hint}`) : ""), input);
  const name = h("input", { id: "name", value: preset?.name ?? new URL(tab.url).hostname });
  const description = h("textarea", { id: "description", rows: 5, value: preset?.description ?? "", placeholder: "What the app does, who uses it, and the business rules that must hold." });
  const focus = h("textarea", { id: "focus", rows: 3, value: (preset?.focusAreas ?? []).join("\n") });
  const outOfScope = h("textarea", { id: "out-of-scope", rows: 2, value: (preset?.outOfScope ?? []).join("\n") });
  const known = h("textarea", { id: "known", rows: 2, value: (preset?.knownIssues ?? []).join("\n") });
  const testData = h("textarea", { id: "test-data", rows: 2, value: Object.entries(preset?.testData ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n"), placeholder: "coupon: SAVE10" });
  const sessions = h("input", { id: "sessions", type: "number", min: 1, max: 10, value: preset?.run?.sessions ?? 3 });
  const steps = h("input", { id: "steps", type: "number", min: 10, max: 150, value: preset?.run?.maxStepsPerSession ?? 40 });
  const readOnly = readOnlyToggle();
  const estimateEl = h("p", { class: "estimate" });
  const error = h("div");
  const models = modelsFor(settings.preset);

  const updateEstimate = () => {
    const perSession = Math.min(estimateSessionCostUsd(models.explorerModel, Number(steps.value), SNAPSHOT_CHARS), settings.sessionCapUsd);
    estimateEl.textContent = `About ${usd(PLANNING_ESTIMATE_USD + Number(sessions.value) * perSession + TRIAGE_ESTIMATE_USD)} in total · each session capped at ${usd(settings.sessionCapUsd)}. Planning costs about ${usd(PLANNING_ESTIMATE_USD)} and you review the plan before sessions run.`;
  };
  sessions.addEventListener("input", updateEstimate);
  steps.addEventListener("input", updateEstimate);
  updateEstimate();

  const template = h(
    "select",
    {
      id: "template",
      "aria-label": "Template",
      onchange: (event: Event) => {
        const chosen = TEMPLATES.find((candidate) => candidate.id === (event.target as HTMLSelectElement).value);
        if (!chosen) return;
        description.value = chosen.description;
        focus.value = chosen.focusAreas.join("\n");
        outOfScope.value = chosen.outOfScope.join("\n");
      },
    },
    h("option", { value: "" }, "Start from a template…"),
    TEMPLATES.map((candidate) => h("option", { value: candidate.id }, candidate.label)),
  );

  const importInput = h("input", {
    type: "file",
    id: "import",
    accept: ".yaml,.yml",
    class: "visually-hidden",
    onchange: async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const imported = parseClientConfigYaml(await file.text(), file.name);
        if (new URL(imported.baseUrl).origin !== tab.origin) {
          error.replaceChildren(notice(`That config is for ${new URL(imported.baseUrl).origin}. Open that site first, then import it.`, "warn"));
          return;
        }
        showFullSetup(tab, imported);
      } catch (err) {
        error.replaceChildren(notice(err instanceof Error ? err.message : String(err), "error"));
      }
    },
  });

  const start = h("button", { class: "primary" }, "Map the site and plan");
  start.addEventListener("click", () => {
    if (!description.value.trim()) return void error.replaceChildren(notice("Describe the app first. It's the agent's only briefing.", "warn"));
    let cfg: ClientConfig;
    try {
      cfg = parseClientConfig(
        {
          name: name.value.trim() || new URL(tab.url).hostname,
          baseUrl: `${tab.origin}/`,
          description: description.value,
          focusAreas: lines(focus.value),
          outOfScope: lines(outOfScope.value),
          knownIssues: lines(known.value),
          testData: pairs(testData.value),
          seedPaths: [new URL(tab.url).pathname],
          allowedOrigins: preset?.allowedOrigins ?? [],
          safety: { ...(preset?.safety ?? {}), blockMutations: readOnly.value() },
          run: {
            sessions: Number(sessions.value),
            maxStepsPerSession: Number(steps.value),
            maxBudgetUsdPerSession: settings.sessionCapUsd,
            plannerModel: models.plannerModel,
            explorerModel: models.explorerModel,
            reconMaxPages: 10,
            snapshotMaxChars: SNAPSHOT_CHARS,
          },
        },
        "setup form",
      );
    } catch (err) {
      return void error.replaceChildren(notice(err instanceof Error ? err.message : String(err), "error"));
    }
    runPlanning(cfg);
  });

  show(
    nav("test"),
    h("div", { class: "row spread" }, h("button", { class: "link", onclick: showHome }, "← Back"), h("label", { class: "link", for: "import" }, "Import YAML config"), importInput),
    h("h2", {}, `Plan a session on ${tab.origin}`),
    template,
    field("name", "Name", name),
    field("description", "Briefing", description, "(the agent's only knowledge of your business rules)"),
    field("focus", "Focus areas", focus, "(one per line)"),
    field("out-of-scope", "Out of scope", outOfScope, "(never tested)"),
    field("known", "Known issues", known, "(not reported again)"),
    field("test-data", "Test data", testData, "(key: value per line)"),
    h("div", { class: "row" }, field("sessions", "Sessions", sessions), field("steps", "Steps each", steps)),
    readOnly.el,
    estimateEl,
    error,
    start,
  );
}

// ---- running ---------------------------------------------------------------------------------------

interface LiveView {
  el: HTMLElement;
  onLog(line: string): void;
  onAction(sessionId: string, entry: ActionLogEntry): void;
  onFinding(finding: Finding): void;
  onCost(total: number): void;
}

function liveView(title: string, capUsd: number): LiveView {
  const status = h("p", { class: "status", "aria-live": "polite" }, "Starting…");
  const cost = h("span", {}, "$0.00");
  const steps = h("span", {}, "0");
  const feed = h("ol", { class: "feed" });
  const findings = h("ul", { class: "findings" });
  const findingsHeading = h("h3", {}, "Findings so far (0)");
  let stepCount = 0;
  let findingCount = 0;
  const stop = h("button", { class: "danger" }, "Stop");
  stop.addEventListener("click", () => {
    activeRun?.stop();
    stop.disabled = true;
    stop.textContent = "Stopping…";
    status.textContent = "Stopping. Findings so far will still be reported.";
  });

  const el = h(
    "div",
    {},
    h("h2", {}, title),
    status,
    h("div", { class: "meters" }, h("div", {}, h("small", {}, "Steps"), steps), h("div", {}, h("small", {}, "Cost"), cost, h("small", {}, ` of ${usd(capUsd)} cap per session`))),
    notice("Keep this panel open while testing. The agent works in its own tab in the “Exploratory Agent” group."),
    findingsHeading,
    findings,
    h("h3", {}, "Activity"),
    feed,
    stop,
  );

  return {
    el,
    onLog(line) {
      if (/^S\d+ →|💭/.test(line.replace(/^\[.*?\] /, ""))) return;
      status.textContent = line.replace(/^S\d+ [▶■✖] /, "");
    },
    onAction(sessionId, entry) {
      stepCount += 1;
      steps.textContent = String(stepCount);
      let target = "";
      try {
        const args = JSON.parse(entry.args);
        target = args.url ?? args.value ?? args.key ?? args.label ?? "";
      } catch {}
      const page = (() => {
        try {
          return new URL(entry.pageUrl).pathname;
        } catch {
          return "";
        }
      })();
      const item = h(
        "li",
        { class: entry.ok ? "" : "failed" },
        h("span", { class: "tool" }, `${sessionId} · ${entry.tool.replace(/_/g, " ")}`),
        target ? h("span", { class: "arg" }, String(target).slice(0, 60)) : "",
        page ? h("span", { class: "muted" }, ` on ${page}`) : "",
        entry.ok ? "" : h("span", { class: "muted" }, ` (failed)`),
      );
      feed.prepend(item);
      while (feed.children.length > 60) feed.lastElementChild?.remove();
    },
    onFinding(finding) {
      findingCount += 1;
      findingsHeading.textContent = `Findings so far (${findingCount})`;
      findings.append(h("li", {}, severityBadge(finding.severity), " ", finding.title));
    },
    onCost(total) {
      cost.textContent = usd(total);
    },
  };
}

function setup(view: LiveView) {
  return { apiKey: settings.apiKey, windowId, handlers: { onLog: view.onLog, onAction: view.onAction, onFinding: view.onFinding, onCost: view.onCost } };
}

function runQuick(cfg: ClientConfig, pageUrl: string, title: string): void {
  const view = liveView(`Testing ${new URL(pageUrl).host}`, cfg.run.maxBudgetUsdPerSession ?? settings.sessionCapUsd);
  show(view.el);
  const { active, done } = startQuickRun(cfg, pageUrl, title, setup(view));
  activeRun = active;
  done.then(({ record, report }) => showResults(record, report)).catch(showRunError).finally(() => (activeRun = undefined));
}

function runPlanning(cfg: ClientConfig): void {
  const view = liveView(`Planning ${cfg.name}`, cfg.run.maxBudgetUsdPerSession ?? settings.sessionCapUsd);
  show(view.el);
  const { active, done } = startPlanning(cfg, setup(view));
  activeRun = active;
  done
    .then((planned) => {
      activeRun = undefined;
      if (active.stopReason) return showRunError(new Error(active.stopReason));
      if (active.stopped) return showHome();
      showPlanReview(cfg, planned);
    })
    .catch((err) => {
      activeRun = undefined;
      showRunError(err);
    });
}

function runCharters(cfg: ClientConfig, charters: Charter[], planned: Partial<PlannedRun> & { plan: NonNullable<RunRecord["plan"]> }): void {
  const view = liveView(`Running ${charters.length} session${charters.length === 1 ? "" : "s"}`, cfg.run.maxBudgetUsdPerSession ?? settings.sessionCapUsd);
  show(view.el);
  const { active, done } = startExecution(cfg, planned.plan, charters, setup(view), planned);
  activeRun = active;
  done.then(({ record, report }) => showResults(record, report)).catch(showRunError).finally(() => (activeRun = undefined));
}

function showRunError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const hint = /401|authentication|api key/i.test(message) ? " Check your API key in Settings." : /credit|billing|402/i.test(message) ? " Check your Anthropic billing." : "";
  show(nav("test"), notice(`The run stopped with an error: ${message.replace(/\.$/, "")}.${hint}`, "error"), h("button", { class: "secondary", onclick: showHome }, "Back"));
}

// ---- plan review -----------------------------------------------------------------------------------

function showPlanReview(cfg: ClientConfig, planned: PlannedRun): void {
  const models = modelsFor(settings.preset);
  const rows = planned.plan.charters.map((charter) => {
    const include = h("input", { type: "checkbox", checked: true, "aria-label": `Include ${charter.id}` });
    const title = h("input", { value: charter.title, "aria-label": `${charter.id} title` });
    const mission = h("textarea", { rows: 3, value: charter.mission, "aria-label": `${charter.id} mission` });
    const steps = h("input", { type: "number", min: 10, max: 150, value: charter.maxSteps, "aria-label": `${charter.id} steps`, class: "narrow" });
    return {
      el: h(
        "article",
        { class: "charter" },
        h("div", { class: "row" }, include, h("strong", {}, charter.id), h("span", { class: `pill pill-${charter.priority}` }, charter.priority), h("span", { class: "muted truncate" }, charter.area)),
        title,
        mission,
        h("div", { class: "row" }, h("span", { class: "muted" }, "Steps"), steps, h("span", { class: "muted truncate" }, `starts at ${new URL(charter.startUrl).pathname}`)),
      ),
      value: (): Charter | undefined => (include.checked ? { ...charter, title: title.value, mission: mission.value, maxSteps: Number(steps.value) } : undefined),
      include,
      steps,
    };
  });

  const run = h("button", { class: "primary" });
  const update = () => {
    const chosen = rows.map((row) => row.value()).filter((charter): charter is Charter => Boolean(charter));
    const cost = chosen.reduce((sum, charter) => sum + Math.min(estimateSessionCostUsd(models.explorerModel, charter.maxSteps, SNAPSHOT_CHARS), settings.sessionCapUsd), TRIAGE_ESTIMATE_USD);
    run.textContent = `Run ${chosen.length} session${chosen.length === 1 ? "" : "s"} · about ${usd(cost)}`;
    run.disabled = chosen.length === 0;
  };
  rows.forEach((row) => {
    row.include.addEventListener("change", update);
    row.steps.addEventListener("input", update);
  });
  update();
  run.addEventListener("click", () => {
    const charters = rows.map((row) => row.value()).filter((charter): charter is Charter => Boolean(charter));
    // The saved plan holds only what ran (with edits), so "Run again" repeats exactly that.
    const plan = { ...planned.plan, charters };
    runCharters(cfg, charters, { ...planned, plan });
  });

  show(
    h("h2", {}, "Review the plan"),
    h("p", {}, planned.plan.overview),
    h("p", { class: "muted" }, `Planning cost ${usd(planned.planCostUsd)}. Untick charters you don't want, or edit them.`),
    ...rows.map((row) => row.el),
    run,
    h("button", { class: "link", onclick: showHome }, "Discard plan"),
  );
}

// ---- results -------------------------------------------------------------------------------------

function issueCard(issue: Issue, detailed: boolean): HTMLElement {
  const finding = issue.primary;
  const copyButton = h("button", { class: "small" }, "Copy as issue");
  copyButton.addEventListener("click", () => copy(`${issue.title}\n\n${issueToMarkdown(issue)}`, copyButton));
  return h(
    "article",
    { class: "issue" },
    h("header", {}, severityBadge(issue.severity), h("strong", {}, issue.title)),
    h("p", { class: "muted" }, `${issue.id} · ${issue.category}${issue.needsVerification ? " · needs verification" : ""}`),
    detailed && [
      h("h4", {}, "Steps"),
      h("ol", {}, finding.steps.map((step) => h("li", {}, step))),
      h("p", {}, h("strong", {}, "Expected: "), finding.expected),
      h("p", {}, h("strong", {}, "Actual: "), finding.actual),
      issue.triageNotes?.length ? h("ul", { class: "muted" }, issue.triageNotes.map((note) => h("li", {}, note))) : "",
    ],
    !detailed && h("p", {}, finding.actual),
    copyButton,
  );
}

function showResults(record: RunRecord, report: RunReport, detailed = settings.role === "qa"): void {
  render = () => {};
  const confirmed = report.issues.filter((issue) => !issue.needsVerification);
  const toVerify = report.issues.filter((issue) => issue.needsVerification);
  const toggle = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "Report view" },
    h("button", { "aria-pressed": !detailed, onclick: () => showResults(record, report, false) }, "Summary"),
    h("button", { "aria-pressed": detailed, onclick: () => showResults(record, report, true) }, "Detailed"),
  );

  const copyReport = h("button", { class: "secondary" }, "Copy report as Markdown");
  copyReport.addEventListener("click", async () => copy(String((await getFile(record.id, "report.md")) ?? ""), copyReport));
  const exports = h(
    "div",
    { class: "actions" },
    h("button", { class: "primary", onclick: () => openReport(record.id) }, "Open full report"),
    copyReport,
    h("button", { class: "secondary", onclick: async () => download(`${record.name}-issues.csv`, String((await getFile(record.id, "issues.csv")) ?? ""), "text/csv") }, "Download CSV"),
    h("button", { class: "secondary", onclick: () => download(`${record.name}.yaml`, clientConfigToYaml(record.config), "text/yaml") }, "Export config for the CLI"),
    h("button", { class: "secondary", onclick: () => runAgain(record) }, "Run again"),
  );

  const shown = detailed ? report.issues : confirmed.slice(0, 5);
  show(
    nav("test"),
    h("div", { class: "row spread" }, h("h2", {}, record.status === "stopped" ? "Stopped early" : "Done"), toggle),
    record.status === "stopped" && record.error ? notice(record.error, "warn") : "",
    h("div", { class: "counts" }, h("div", {}, h("b", {}, confirmed.length), "issues"), h("div", {}, h("b", {}, toVerify.length), "to verify"), h("div", {}, h("b", {}, report.autos.length), "runtime errors"), h("div", {}, h("b", {}, usd(report.totalCostUsd)), "cost")),
    h("ul", { class: "summary" }, report.summary.map((line) => h("li", {}, line))),
    h("h3", {}, detailed ? "All issues" : confirmed.length > 5 ? "Fix these first" : "Issues"),
    shown.length ? shown.map((issue) => issueCard(issue, detailed)) : h("p", { class: "muted" }, "No confirmed issues."),
    !detailed && toVerify.length ? h("p", { class: "muted" }, `${toVerify.length} more to verify in the detailed view.`) : "",
    report.autos.length
      ? [
          h("h3", {}, "Runtime errors detected automatically"),
          h("ul", { class: "autos" }, (detailed ? report.autos : report.autos.slice(0, 3)).map((auto) => h("li", {}, severityBadge(auto.severity), ` ${auto.occurrences}× `, h("code", {}, auto.actual)))),
        ]
      : "",
    detailed &&
      report.sessions.map((session) =>
        h("details", { class: "session" }, h("summary", {}, `${session.sessionId} · ${session.charter.title} · ${session.stopReason}, ${session.stepsUsed}/${session.charter.maxSteps} steps`), h("p", {}, session.summary ?? "No summary."), session.areasNotCovered.length ? h("p", { class: "muted" }, `Not covered: ${session.areasNotCovered.join("; ")}`) : ""),
      ),
    exports,
  );
}

function openReport(runId: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`report.html?run=${encodeURIComponent(runId)}`) });
}

async function loadReport(runId: string): Promise<RunReport | undefined> {
  const json = await getFile(runId, "report.json");
  return json ? (JSON.parse(String(json)) as RunReport) : undefined;
}

async function runAgain(record: RunRecord): Promise<void> {
  if (!record.plan) return;
  if (record.mode === "quick" && record.pageUrl) {
    if (record.config.name === DEMO_CONFIG.name) await demoLogin(record.config, windowId).catch(() => {});
    runQuick(record.config, record.pageUrl, record.plan.charters[0]?.area ?? "");
  } else {
    runCharters(record.config, record.plan.charters, { plan: record.plan });
  }
}

// ---- history ---------------------------------------------------------------------------------------

async function showHistory(): Promise<void> {
  render = showHistory;
  if (activeRun) return;
  const runs = await listRuns();
  const statusLabel: Record<RunRecord["status"], string> = { running: "interrupted", done: "done", stopped: "stopped early", error: "failed" };
  const item = (run: RunRecord) =>
    h(
      "article",
      { class: "history-item" },
      h("div", { class: "row spread" }, h("strong", { class: "truncate" }, run.name), h("span", { class: "muted" }, timeAgo(run.createdAt))),
      h(
        "p",
        { class: "muted" },
        `${run.mode === "quick" ? "Quick check" : `${run.plan?.charters.length ?? "?"} sessions`} · ${statusLabel[run.status]}`,
        run.totals ? ` · ${run.totals.confirmed} issues, ${run.totals.toVerify} to verify · ${usd(run.totals.costUsd)}` : "",
      ),
      run.error ? h("p", { class: "muted" }, run.error) : "",
      h(
        "div",
        { class: "row" },
        run.totals && h("button", { class: "small", onclick: async () => { const report = await loadReport(run.id); if (report) showResults(run, report); } }, "Results"),
        run.totals && h("button", { class: "small", onclick: () => openReport(run.id) }, "Report"),
        run.plan && h("button", { class: "small", onclick: () => runAgain(run) }, "Run again"),
        h("button", { class: "small subtle", onclick: async () => { await deleteRun(run.id); showHistory(); } }, "Delete"),
      ),
    );
  show(nav("history"), runs.length ? runs.map(item) : h("p", { class: "muted" }, "No runs yet."));
}

// ---- settings ----------------------------------------------------------------------------------------

function showSettings(): void {
  render = () => {};
  if (activeRun) return;
  const radio = <T extends string>(name: string, value: T, current: T, label: string, hint: string, onPick: (value: T) => void) =>
    h("label", { class: "check" }, h("input", { type: "radio", name, value, checked: value === current, onchange: () => onPick(value) }), h("span", {}, h("strong", {}, label), ` · ${hint}`));

  const cap = h("input", { id: "cap", type: "number", min: 0.1, step: 0.1, value: settings.sessionCapUsd, class: "narrow" });
  cap.addEventListener("change", async () => {
    const value = Number(cap.value);
    if (value > 0) settings = await saveSettings({ sessionCapUsd: value });
  });

  show(
    nav("settings"),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "API key"),
      h("p", { class: "muted" }, settings.apiKey ? `Saved: ${settings.apiKey.slice(0, 10)}…${settings.apiKey.slice(-4)}` : "Not set."),
      h("button", { class: "secondary", onclick: showOnboarding }, "Replace key"),
      h("p", { class: "fine" }, "Stored only in this browser (not encrypted). Only sent to api.anthropic.com."),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "I'm mainly a…"),
      radio<Role>("role", "developer", settings.role ?? "developer", "Developer or founder", "one-click checks, summary first", async (role) => (settings = await saveSettings({ role }))),
      radio<Role>("role", "qa", settings.role ?? "developer", "QA tester", "planned sessions, detailed reports", async (role) => (settings = await saveSettings({ role }))),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Models"),
      (Object.keys(PRESETS) as ModelPreset[]).map((preset) => radio<ModelPreset>("preset", preset, settings.preset, PRESETS[preset].label, PRESETS[preset].description, async (value) => (settings = await saveSettings({ preset: value })))),
      h("div", { class: "field" }, h("label", { for: "cap" }, "Hard cap per session (USD)"), cap),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Sites you've confirmed you may test"),
      settings.authorizedOrigins.length
        ? h(
            "ul",
            { class: "plain" },
            settings.authorizedOrigins.map((origin) =>
              h("li", { class: "row spread" }, origin, h("button", { class: "small subtle", onclick: async () => { settings = await saveSettings({ authorizedOrigins: settings.authorizedOrigins.filter((item) => item !== origin) }); showSettings(); } }, "Remove")),
            ),
          )
        : h("p", { class: "muted" }, "None yet."),
    ),
  );
}

// ---- start ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  settings = await loadSettings();
  windowId = (await chrome.windows.getCurrent()).id;
  // Follow the user's tab while the home view is showing, without wiping a half-typed form.
  const onTabChange = async () => {
    const before = currentTab?.url;
    await refreshTab();
    if (currentTab?.url !== before) render();
  };
  chrome.tabs.onActivated.addListener(onTabChange);
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.status === "complete") void onTabChange();
  });
  if (!settings.apiKey) showOnboarding();
  else if (!settings.role) showRoleChoice();
  else showHome();
}

main().catch((err) => show(notice(`Error: ${err instanceof Error ? err.message : String(err)}`, "error")));
