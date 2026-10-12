import type { BrowserContext } from "playwright";

// Lets the extension open private windows, as "Allow in Incognito" does. Chrome reloads the
// extension to apply it, and only keeps an unpacked extension enabled in developer mode.
export async function allowIncognito(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  const reloaded = context.waitForEvent("serviceworker");
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve) => {
        const dev = (chrome as any).developerPrivate;
        dev.updateProfileConfiguration({ inDeveloperMode: true }, () => dev.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true }, () => resolve()));
      }),
    extensionId,
  );
  await reloaded;
  await page.close();
}
