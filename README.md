# Exploratory testing agent

A reusable harness that uses Claude to run session-based exploratory testing against any web application. Point it at a client's site with a small YAML file and it will map the app, write a test plan, run time-boxed exploration sessions in a real browser, and produce a triaged bug report.

```
recon ──► plan ──► sessions (Claude drives Chromium) ──► triage ──► report.html / .pdf / .md / .csv / .json
```

There are two ways to use it:

- **Browser extension** for Chrome, Edge and other Chromium browsers: test the site you're on from a side panel, with no setup beyond an API key. See [Browser extension](#browser-extension).
- **Command-line tool** for repeatable client runs and CI: the rest of this README.

Both run the same pipeline from `packages/core`, and a config exported from the extension runs unchanged in the CLI.

## Browser extension

Until it's in the Chrome Web Store, load it unpacked:

```bash
npm install
npm run build:extension            # writes packages/extension/dist
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `packages/extension/dist`. Click the extension's toolbar icon to open the side panel.

- **Find bugs on this page:** a Quick check. One ~25-step session on the current page, then triage. A Sonnet session usually costs $0.20–0.30.
- **Plan a session:** Full mode. Recon, a plan you review and edit, several sessions, then a full report.
- **Try it on a demo shop:** logs in to saucedemo.com as its deliberately buggy `problem_user` and runs a Quick check.

How it differs from the CLI:

- **Login:** there's no auth config. The agent uses your browser's session, so log in to the site first, ideally with a test account.
- **Where it runs:** the agent works in its own tab in an "Exploratory Agent" tab group. Chrome shows a "started debugging this browser" bar while it runs, and dismissing that bar stops the run.
- **Read-only by default:** form submissions and other changes are blocked unless you untick it.
- **Keep the side panel open** during a run.
- **Storage:** your API key, settings, run history and reports stay in the browser. Page content is sent only to api.anthropic.com. See the [privacy policy](packages/extension/store/PRIVACY.md).

## Setup

Requires Node.js 20+.

```bash
npm install
npm run setup-browsers          # downloads Chromium for Playwright
cp .env.example .env            # add ANTHROPIC_API_KEY and any client credentials
```

## Running it

```bash
# Try it on the public demo shop (problem_user is deliberately buggy)
npm run explore -- --client clients/saucedemo.yaml

# Recommended for client work: review the plan before spending on sessions
npm run explore -- --client clients/acme.yaml --plan-only
#   ...edit runs/acme/<timestamp>/plan.json if needed, then:
npm run explore -- --client clients/acme.yaml --plan runs/acme/<timestamp>/plan.json

# Re-run only some charters, and watch the browser
npm run explore -- --client clients/acme.yaml --plan <plan.json> --charters C02,C04 --headed --verbose
```

Each run writes to `runs/<client>/<timestamp>/`:

| File | What it is |
|---|---|
| `report.html` | Client-ready report with screenshots, severity counts and coverage |
| `report.pdf` | Same report, printable/shareable as a PDF |
| `report.md` | Same content in Markdown |
| `issues.csv` | One row per issue, ready to import into Jira, Azure DevOps or Linear |
| `report.json` | Everything, machine-readable |
| `plan.md` / `plan.json` | The test plan (charters) |
| `sitemap.md` | What reconnaissance found |
| `sessions/S01.json` … | Full action log, findings and runtime signals per session |
| `screens/` | Evidence screenshots |

## Adding a client

Copy `clients/_template.yaml` to `clients/<client>.yaml`. Only `name`, `baseUrl` and `description` are required, but results improve a lot when you fill in focus areas, out-of-scope items, known issues and test data. The description is the agent's only knowledge of the business rules, so treat it like a briefing for a new tester.

Login options:

- **`form`**: the harness logs in itself before any session, using credentials from environment variables named in the config. Credentials never appear in prompts, so Claude never sees them. The username, password and submit-button selectors are optional — the harness auto-detects them on the login page (password field, then an email/username-shaped field, then the submit control). Set `usernameSelector`/`passwordSelector`/`submitSelector` explicitly only if auto-detection fails or you want to pin it to a specific element.
- **`storageState`**: for SSO, MFA or CAPTCHA logins. Log in by hand once with `npx playwright codegen --save-storage=clients/acme.auth.json <url>` and point the config at that file. Cookies expire, so regenerate when sessions start landing on the login page.

Both `form` and `storageState` work by capturing cookies, localStorage and IndexedDB (covers apps like Firebase Auth that keep their session there) after logging in once, then replaying that into every session's browser. Apps that keep auth tokens only in `sessionStorage` aren't covered by either method — sessions will appear logged out.

## How it works

**Reconnaissance** crawls up to `reconMaxPages` same-origin pages and records headings, navigation, forms, inputs and buttons. For single-page apps whose menus aren't plain links, add `seedPaths`.

**Planning** (default model: Opus) turns the description, focus areas and site map into charters of the form *"Explore <target> with <resources> to discover <information>"*, ordered by risk.

**Sessions** (default model: Sonnet) each get a fresh, isolated browser that starts logged in at the charter's URL. Claude sees the page as an accessibility tree, acts through tools (navigate, click, fill, press_key, select_option, set_checked, hover, go_back, reload, set_viewport, wait, snapshot, screenshot), and records defects with `record_finding` as it goes, including repro steps, expected/actual, confidence, whether it reproduced the issue, and an automatic screenshot. The step budget is a hard limit.

**Runtime signals** are captured automatically in every session without Claude asking: uncaught JavaScript exceptions, console errors, HTTP 4xx/5xx from the app, and failed requests. They are attributed to the action that caused them (the harness waits for XHR/fetch to settle after each action) and appear as a deduplicated "Runtime errors detected automatically" section. For JavaScript apps this section alone often justifies a run.

**Triage** (default model: Opus) merges duplicates across sessions, calibrates severity, flags anything unreproduced or possibly intentional as *Needs verification*, and writes the executive summary. Nothing gets dropped: any finding triage misses is reported as its own issue.

## Safety

These guardrails matter when you are pointing an autonomous agent at someone else's system:

- Always use a test or staging environment and test accounts, with the client's written authorisation.
- The agent can only use the testing tools above. Claude Code's built-in tools (shell, files, web) are disabled, and local settings and other MCP servers are ignored.
- Top-level navigation outside the app's origins is blocked at the network layer, not just by instruction.
- Logout URLs are blocked by default, because logging out can invalidate the shared session for every later session.
- `confirm()` dialogs are dismissed automatically, so destructive confirmations don't go through.
- `safety.blockMutations: true` aborts every POST/PUT/PATCH/DELETE to the app, for read-only exploration of shared environments. `safety.blockedRequests` lets you block specific endpoints, such as payment or email-sending APIs.
- The saved login state is deleted at the end of each run.

## Cost and tuning

Cost scales with sessions × steps. Each step sends a page snapshot to the model, so `snapshotMaxChars` and `maxStepsPerSession` are the main levers. Every session's estimated cost is logged, the total is in the report, and `maxBudgetUsdPerSession` sets a hard cap. Start with 3 sessions of 40 steps on a new client and scale up once the plan and config look right.

To speed up large runs, set `concurrency: 2` or `3`. Sessions are isolated browser contexts, but they share the same test account, so avoid high concurrency on apps where simultaneous edits to one account would interfere.

Tips for better results:

- Put business rules in the description ("VAT is 20%", "free delivery over £50"). The agent can only spot wrong behaviour if it knows what right looks like.
- Use `ignoreSignals` to silence third-party script noise so real errors stand out.
- Use `knownIssues` on repeat runs so reports only contain new problems.
- Treat *Needs verification* items as leads for a human tester, not confirmed bugs.

## Project layout

An npm workspaces monorepo. The pipeline lives in `core` and is shared by the CLI and the Chromium extension, so both stay at feature parity. See [docs/chromium-extension-plan.md](docs/chromium-extension-plan.md).

```
packages/
  core/                 platform-neutral pipeline (no Node APIs, runs in a browser too)
    src/config.ts       client YAML schema (zod), parser and YAML export
    src/driver.ts       BrowserDriver interface, SafetyPolicy (guardrails), SignalBuffer
    src/agent.ts        AgentRunner interface and tool definitions
    src/messages-runner.ts  AgentRunner on the Messages API (used by the extension)
    src/models.ts       model aliases, prices and cost estimates
    src/recon.ts        site mapping for the planner
    src/planner.ts      charter generation
    src/tools.ts        tools exposed to the exploring agent
    src/explorer.ts     runs one charter as an agent session
    src/pipeline.ts     sessions → triage → report, and the Quick-mode charter
    src/triage.ts       runtime-error grouping and AI triage
    src/report.ts       HTML / Markdown / CSV / JSON report renderers
    src/prompts.ts      all prompts in one place, easy to tune
    test/               unit tests (node:test)
  cli/                  the command-line app
    src/cli.ts          orchestration and command-line options
    src/playwright-driver.ts  BrowserDriver on Playwright: guardrails, signal capture, actions
    src/sdk-runner.ts   AgentRunner on the Claude Agent SDK (locked-down tool set)
    src/auth.ts         one-time login and shared storage state
    src/pdf.ts          report.pdf rendering
  extension/            Chromium extension (Manifest V3 side panel)
    src/cdp-driver.ts   BrowserDriver over chrome.debugger: element refs, guardrails, signals
    src/ax-tree.ts      accessibility tree → snapshot with [ref=eN] refs
    src/runs.ts         Quick and Full runs in the side panel
    src/sidepanel.ts    the UI
    src/report-page.ts  full report viewer and exports
    test/               unit tests, and end-to-end tests in real Chromium
    store/              store listing, permission justifications, privacy policy
```

## Development

```bash
npm run typecheck        # all packages
npm test                 # unit tests (core and extension)
npm run build:extension  # bundle to packages/extension/dist, then "Load unpacked" in chrome://extensions
npm run test:e2e -w @exploratory-agent/extension    # extension in real Chromium, fake API, no cost
npm run package -w @exploratory-agent/extension     # release zip for the Chrome Web Store / Edge Add-ons
RUN_PAID_TESTS=1 npm run test:e2e -w @exploratory-agent/extension   # also a real run on saucedemo (~$0.25)
```

CI runs the free checks on every push and pull request. `.github/workflows/nightly.yml` runs both apps against saucedemo with the real API every night, but only after you add an `ANTHROPIC_API_KEY` repository secret.

New pipeline features go in `core` first, then each app exposes them.
