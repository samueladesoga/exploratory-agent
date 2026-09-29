# Exploratory Agent privacy policy

_Last updated: 29 September 2026_

Exploratory Agent is a browser extension that uses Anthropic's Claude models to test websites you choose. It has no server of its own, and its developer never receives your data.

## What the extension handles

- **Your Anthropic API key.** Stored in your browser's extension storage (`chrome.storage.local`) on your device. This storage is not encrypted. The key is only ever sent to `api.anthropic.com`, to make the requests you start.
- **Content of the sites you test.** When you start a run, the extension reads the pages it tests (accessibility tree, page text, URLs and screenshots) and sends them to Anthropic's API so the model can decide what to do next. It only reads tabs it opens for a run, and only after you start that run.
- **Run history and reports.** Reports, screenshots and session logs are stored in your browser's IndexedDB on your device. You can delete any run from the History tab, or all of them by removing the extension.
- **Settings.** Your role, model choice, cost cap and the list of sites you've confirmed you may test, stored in `chrome.storage.local`.

## What is sent where

| Data | Sent to | When |
|---|---|---|
| Page content and screenshots from test tabs, your briefing text | api.anthropic.com | During a run you started |
| Your API key | api.anthropic.com (as the request credential) | During a run, and once when you save the key |

Nothing is sent to the extension's developer or any other third party. The extension has no analytics or tracking.

Anthropic processes API requests under its own terms and privacy policy: https://www.anthropic.com/legal/privacy

## Your choices

- Only test sites you own or have permission to test. The extension asks you to confirm this for each site.
- Use test accounts and test environments. The agent sees whatever the logged-in test tab shows.
- Read-only mode (on by default) blocks form submissions and other changes during a run.
- Delete runs in History, or remove your key in Settings.

## Contact

Questions: open an issue in the project's repository.
