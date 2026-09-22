import { chromium } from "playwright";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ClientConfig } from "./config.js";
import type { Logger } from "./util.js";

export interface AuthState {
  storageState?: string;
  temporary: boolean;
}

export async function prepareAuth(cfg: ClientConfig, runDir: string, headless: boolean, log: Logger): Promise<AuthState> {
  const auth = cfg.auth;
  if (auth.type === "none") return { temporary: false };

  if (auth.type === "storageState") {
    const file = path.resolve(auth.path);
    await access(file).catch(() => {
      throw new Error(`auth.path ${file} not found. Create it with: npx playwright codegen --save-storage=${auth.path} ${cfg.baseUrl}`);
    });
    return { storageState: file, temporary: false };
  }

  const username = process.env[auth.usernameEnv];
  const password = process.env[auth.passwordEnv];
  if (!username || !password) {
    throw new Error(`Set ${auth.usernameEnv} and ${auth.passwordEnv} in your environment or .env file.`);
  }

  log(`Logging in at ${auth.loginUrl}`);
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: cfg.browser.ignoreHttpsErrors });
    const page = await context.newPage();
    await page.goto(auth.loginUrl, { waitUntil: "domcontentloaded" });
    await page.locator(auth.usernameSelector).first().fill(username);
    await page.locator(auth.passwordSelector).first().fill(password);
    await page.locator(auth.submitSelector).first().click();
    if (auth.successSelector) {
      await page.locator(auth.successSelector).first().waitFor({ timeout: 20_000 }).catch(() => {
        throw new Error(`Login did not reach success selector ${auth.successSelector}. Check credentials and selectors.`);
      });
    } else {
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }
    const file = path.join(runDir, "session.auth.json");
    await context.storageState({ path: file });
    log("Login succeeded; sessions will start authenticated.");
    return { storageState: file, temporary: true };
  } finally {
    await browser.close();
  }
}
