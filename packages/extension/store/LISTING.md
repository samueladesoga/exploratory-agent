# Chrome Web Store / Edge Add-ons listing

Everything the store forms ask for, ready to paste. The upload file comes from `npm run package -w @exploratory-agent/extension`, which writes `packages/extension/exploratory-agent-extension.zip`. The same zip works for Microsoft Edge Add-ons.

## Name

Exploratory Agent

## Short description (max 132 characters)

An AI tester that explores the site you're on and reports the bugs it finds. Bring your own Anthropic API key.

## Category

Developer Tools

## Detailed description

Exploratory Agent is an AI exploratory tester that lives in your browser's side panel.

**Find bugs on this page.** One click starts a short testing session on the page you're looking at. The agent tries realistic and edge-case inputs, disrupts flows (back, reload, double submit), checks the layout at phone width, and records each defect with steps to reproduce, expected and actual behaviour, and a screenshot. It also catches JavaScript exceptions, console errors and failing requests automatically.

**Plan a session.** For QA teams: the agent maps the site, writes session charters you can review and edit, runs them, and triages everything into one report, with confirmed issues first and uncertain ones flagged for a human to verify.

**Reports you can use.** Summary or detailed view in the panel, a full HTML report you can print to PDF, CSV for Jira, Azure DevOps or Linear, Markdown, JSON, and one-click "Copy as issue".

**Safe by default.**
- Read-only mode blocks form submissions and other changes unless you turn it off.
- The agent can't leave the site you're testing.
- Logout links are blocked so your session survives.
- Confirmation dialogs are dismissed automatically.
- The agent works in its own tab, never yours.
- You confirm you're allowed to test each site.

**Your key, your data.** Bring your own Anthropic API key. You see a cost estimate before every run and set a hard cap per session. The extension has no server: runs, reports and your key stay in your browser, and page content goes only to Anthropic's API.

**Works with the CLI.** Export any run's configuration as YAML and run it with the open-source command-line version, for example in CI.

Only test sites you own or have written permission to test, ideally a staging environment with test accounts.

## Single purpose

Runs AI-driven exploratory tests on websites the user chooses and reports the defects found.

## Permission justifications

| Permission | Why it's needed |
|---|---|
| `debugger` | The agent operates a test tab the way a user would: it reads the page's accessibility tree, clicks and types, takes screenshots, and records JavaScript exceptions, console errors and failing network requests. It also enforces the safety rules (blocking off-site navigation, logout and, in read-only mode, form submissions) by intercepting requests. It is only attached to tabs the extension opens for a run the user started, and it is detached when the run ends. |
| `tabs` | Reads the URL and title of the active tab so the user can test the site they're on, and opens the test tab. |
| `tabGroups` | Puts the test tab in a labelled "Exploratory Agent" group so the user can see which tab the agent is driving. |
| `sidePanel` | The extension's interface is a side panel. |
| `storage` | Stores the user's settings and API key locally. |
| `unlimitedStorage` | Stores run history, reports and screenshots in IndexedDB on the user's device. |
| Host permission `https://api.anthropic.com/*` | Sends requests to Anthropic's API with the user's own key. No other hosts. |

## Remote code

No. All code ships in the package. The extension sends page content to Anthropic's API and receives model responses (text and tool calls), which it never executes as code.

## Data usage disclosures

- Collects: website content (only from test tabs during a run the user starts), authentication information (the user's own Anthropic API key, stored locally).
- Not sold, not used for unrelated purposes, not used for creditworthiness or lending.
- Transferred only to Anthropic's API, to provide the extension's single purpose.

Privacy policy: host `store/PRIVACY.md` at a public URL (for example the file's GitHub page) and paste that URL into the form.

## Images and video

`npm run store:assets -w @exploratory-agent/extension` regenerates the images in `store/assets/`, and `npm run store:video -w @exploratory-agent/extension` records the video. Both drive the real extension against a local demo shop (`store/demo.ts`) with a scripted stand-in for the API, so they need no key and cost nothing. The folder is git-ignored: regenerate the files before each store update so they match the release.

- Screenshots (1280x800, upload in this order): `screenshot-1-find-bugs.png`, `screenshot-2-live-run.png`, `screenshot-3-results.png`, `screenshot-4-report.png`, `screenshot-5-plan.png`.
- Small promo tile (440x280): `promo-small-440x280.png`.
- Marquee promo tile (1400x560, optional, used if the store features the extension): `marquee-1400x560.png`.
- Demo video (1280x720, about 40 seconds, no audio): `demo.webm`. Upload it to YouTube (public or unlisted), and paste the YouTube URL into the store form.
