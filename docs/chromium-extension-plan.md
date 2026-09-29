# Plan: Exploratory Agent as a Chromium extension

Status: planned, not started (2026-09-29)

## Goal

Get more people to try the app. Today, trying it means cloning the repo, installing Node 20, downloading Playwright's Chromium, writing a YAML file and running a CLI. The extension should cut that down to "install, add an API key, click **Test this site**."

## Decisions

- **Bring-your-own Anthropic API key.** No hosted backend.
- **The CLI stays a first-class product.** The CLI and the extension share one core.
- **Two audiences, one engine.** The extension serves both QA professionals and developers/founders, showing more detail as users ask for it.

## Main constraint

Playwright (`src/browser.ts`) and the Claude Agent SDK (`src/agent.ts`, which starts a local Claude Code process) both need Node, so neither can run inside an extension. The plan ports the browser and agent layers and reuses everything else.

| Current piece | In the extension |
|---|---|
| `browser.ts` (Playwright) | New CDP driver using `chrome.debugger` |
| `agent.ts` (Agent SDK) | Direct Messages API tool-use loop |
| `auth.ts` (form login / storageState) | Not needed: the user is already logged in, in their own browser |
| `tools.ts` | Same tool names and step budget; selectors become element refs |
| `prompts.ts`, `types.ts`, `config.ts` (zod), triage + report writers | Reused almost unchanged |
| `recon.ts` | Same logic, run in a background tab |
| YAML client file | A form in the side panel, with YAML import/export |

Dropping the auth step is the biggest UX gain. SSO, MFA, CAPTCHA and sessionStorage-only apps, which are the current weak spots, all just work.

## Architecture

- **Manifest V3 extension**, built with Vite and esbuild.
- **Side panel UI** (`chrome.sidePanel`):
  1. **Setup:** description, focus areas, mode (Quick or Full), and a cost estimate.
  2. **Live view:** a feed of actions, findings as they're recorded, a step and cost meter, and a Stop button.
  3. **Results:** triaged issues, the report, and export.
- **Where the agent loop runs:** in the side panel page or an offscreen document, not the service worker. MV3 service workers get killed when idle, which would cut long sessions off partway through.
- **CDP driver:** implements the same interface as the Playwright harness.
  - Snapshots use `Accessibility.getFullAXTree`, with a short ref per element (`button "Save" [ref=e14]`).
  - Actions are `click(ref)` and `fill(ref, text)`, sent as real input through `Input.dispatch*`.
  - Screenshots use `Page.captureScreenshot`.
- **Runtime signals** come from CDP: `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.responseReceived` / `loadingFailed`.
- **Guardrails** use CDP `Fetch.enable` request interception, which covers:
  - blocking navigation to other origins
  - blocking logout URLs
  - `blockMutations`
  - `blockedRequests`

  `confirm()` dialogs are auto-dismissed through `Page.javascriptDialogOpening`.
- **Reports:**
  - HTML is rendered in an extension page.
  - PDF comes from `Page.printToPDF`.
  - CSV, JSON and Markdown are saved with `chrome.downloads`.
  - Past runs are stored in IndexedDB.

## Shared core (CLI stays first-class)

```
packages/core/       prompts, types, config schema, charter/triage logic, report writers
                     + interfaces: BrowserDriver, AgentRunner, Storage
packages/cli/        Playwright driver, Agent SDK runner, fs storage  (today's app)
packages/extension/  CDP driver, Messages-API runner, IndexedDB storage, side panel UI
```

**Parity rules:**

- Every feature lands in core first, then each app exposes it.
- Both apps share one config schema. YAML exported from the extension runs unchanged in the CLI, and the reverse.
- Both write the same `report.json` shape, so the report viewer works for either.

**CI:**

- `typecheck` plus unit tests for core.
- A nightly saucedemo run through both drivers, which must find the same known bugs.

**Handoff:** "Export to CLI" in the extension produces the YAML plus the command to run it.

## Bring-your-own key

- **Onboarding:** "Paste your Anthropic API key", with a link to console.anthropic.com. The extension checks the key with a tiny API call before saving it.
- **Storage:** the key stays in `chrome.storage.local` (not encrypted, and the UI says so). It is only ever sent to `api.anthropic.com`.
- **Privacy policy:** there's no server, and nothing is sent to us.
- **Cost controls:**
  - an estimate before every run
  - a hard cap per run, defaulting to about $1 in Quick mode
  - a running total of spend in the history view
  - these are reimplemented from API `usage`, replacing the Agent SDK's `maxBudgetUsd` and `maxTurns`
- **Model picker:** the same defaults as the CLI (Opus for planning and triage, Sonnet for sessions), plus a cheaper "Budget" preset.

## Two audiences

| | Developers / founders | QA professionals |
|---|---|---|
| Entry point | **"Find bugs on this page"**: one click, Quick mode | **"Plan a session"**: Full mode |
| Setup | Optional one-line description | Description, focus areas, out-of-scope items, known issues, test data |
| Plan | Hidden (auto-generated) | Charter review and editing before spending money |
| Live view | Plain-language feed and found-bug count | Adds the step log, charter coverage and signals |
| Report | Summary first: top issues, runtime errors, "fix these first" | Full report: charters, coverage, repro steps, Needs-verification items |
| Export | Copy as Markdown / GitHub issue | CSV for Jira, Azure DevOps or Linear, PDF, JSON, YAML config |

- **Role question at onboarding:** "I'm mainly a… developer or founder / QA tester." It only sets the default view, and a toggle in the panel switches it anytime.
- **Report views:** one report with a "Summary / Detailed" switch.

## Defaults for first-time users

- **Quick mode:** skip recon, run 1 charter of about 25 steps on the current page, then triage. Target: under 2 minutes and a few cents.
- **Read-only by default** (`blockMutations: true`). Users opt in to letting the agent submit forms.
- **Authorisation checkbox** before each new origin: "I own this site or have permission to test it."
- **Demo button** that runs against saucedemo's `problem_user`.
- **Permissions:**
  - `debugger`, `sidePanel`, `storage`, `downloads`, `tabs`, `offscreen`
  - site access requested per site through `optional_host_permissions`, not `<all_urls>` at install

## Phases

1. **Core refactor:** extract `packages/core` and set up the `cli` and `extension` packages. The CLI should behave exactly as it does today, and CI goes in.
2. **Spike (about 2–3 days):** CDP driver plus Messages API loop on one charter. Compare click reliability, snapshot size and cost per step with Playwright on saucedemo.
3. **MVP (developers and founders first):**
   - key onboarding and cost caps
   - Quick mode and the live feed
   - runtime signals
   - the Summary report
   - Markdown export
   - the saucedemo demo button
4. **QA layer:**
   - Full mode with recon and plan review
   - multiple sessions run one after another
   - the Detailed report
   - CSV, PDF and JSON exports
   - YAML import/export and "Export to CLI"
   - run history
5. **Ship:** Chrome Web Store and Edge Add-ons listings, privacy policy, `debugger` permission justification, demo video.
6. **Growth:** "Run again" for regression, and templates by app type (e-commerce, SaaS dashboard, marketing site).

## Risks

- **Debugging banner:** Chrome shows a "started debugging this browser" bar while `chrome.debugger` is attached. It can't be hidden, so frame it in the UI as "the agent is driving this tab."
- **Clicks via CDP:** less robust than Playwright's auto-waiting. The driver needs its own wait-for-network-idle and actionability checks, which the spike should measure.
- **Shared session:** runs use the user's real session and cookies. Concurrency stays at 1, and read-only mode matters even more.
- **Store review:** the `debugger` permission gets reviewed closely. All logic must ship in the bundle, with no remotely fetched code.
