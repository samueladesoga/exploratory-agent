import { parseClientConfig, SafetyPolicy } from "@exploratory-agent/core";

// Skeleton: builds a client config for the active tab with the shared core, to prove core runs in
// the extension. The testing UI replaces this in the MVP.
async function main(): Promise<void> {
  const status = document.getElementById("status")!;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("http")) {
    status.textContent = "Open a website to test it.";
    return;
  }
  const cfg = parseClientConfig(
    { name: new URL(tab.url).hostname, baseUrl: new URL(tab.url).origin, description: "Site under test", safety: { blockMutations: true } },
    "side panel",
  );
  const policy = new SafetyPolicy(cfg);
  status.innerHTML = "";
  status.append("Ready to test ", Object.assign(document.createElement("code"), { textContent: [...policy.allowedOrigins].join(", ") }), " (read-only).");
}

main().catch((err) => {
  document.getElementById("status")!.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
});
