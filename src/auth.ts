import { chromium, type Locator, type Page } from "playwright";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ClientConfig } from "./config.js";
import type { Logger } from "./util.js";

export interface AuthState {
  storageState?: string;
  temporary: boolean;
}

// Heuristics for auto-detecting login fields when the client config doesn't specify
// selectors. Tried in order, most-specific first; the first visible match wins.
const USERNAME_HINTS = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="user" i]',
  'input[aria-label*="email" i]',
  'input[aria-label*="user" i]',
];

const SUBMIT_TEXT = /log\s?in|sign\s?in|submit|continue/i;

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return undefined;
}

async function findPasswordField(page: Page): Promise<Locator | undefined> {
  const locator = page.locator('input[type="password"]');
  // Client-rendered login forms (React/Vue SPAs) may not exist yet at domcontentloaded.
  await locator.first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  return firstVisible(locator);
}

// Scopes the username/submit search to the surrounding <form>, falling back to the whole
// page for apps that build login UI without a real <form> element.
async function loginFormScope(page: Page, passwordField: Locator | undefined): Promise<Locator> {
  if (passwordField) {
    const ancestorForm = passwordField.locator("xpath=ancestor::form[1]");
    if (await ancestorForm.count()) return ancestorForm;
  }
  const anyForm = page.locator("form").first();
  if (await anyForm.count()) return anyForm;
  return page.locator("body");
}

async function findUsernameField(scope: Locator): Promise<Locator | undefined> {
  for (const hint of USERNAME_HINTS) {
    const found = await firstVisible(scope.locator(hint));
    if (found) return found;
  }
  // Last resort: the first plain text input in scope — usually the username box
  // when the site uses selectors (data-testid etc.) none of the hints above catch.
  return firstVisible(scope.locator('input[type="text"], input:not([type])'));
}

async function findSubmitControl(page: Page, scope: Locator): Promise<Locator | undefined> {
  const byType = await firstVisible(scope.locator('button[type="submit"], input[type="submit"]'));
  if (byType) return byType;
  return firstVisible(page.getByRole("button", { name: SUBMIT_TEXT }));
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

    const autoDetecting = !auth.usernameSelector || !auth.passwordSelector || !auth.submitSelector;
    if (autoDetecting) log("Detecting login fields automatically (no selectors configured).");

    const passwordField = auth.passwordSelector ? page.locator(auth.passwordSelector).first() : await findPasswordField(page);
    if (!passwordField) {
      throw new Error("Could not automatically find a password field on the login page. Set auth.passwordSelector in the client config.");
    }
    const scope = await loginFormScope(page, passwordField);

    const usernameField = auth.usernameSelector ? page.locator(auth.usernameSelector).first() : await findUsernameField(scope);
    if (!usernameField) {
      throw new Error("Could not automatically find a username/email field on the login page. Set auth.usernameSelector in the client config.");
    }

    const submitControl = auth.submitSelector ? page.locator(auth.submitSelector).first() : await findSubmitControl(page, scope);
    if (!submitControl) {
      throw new Error("Could not automatically find a login/submit button on the login page. Set auth.submitSelector in the client config.");
    }

    await usernameField.fill(username);
    await passwordField.fill(password);
    await submitControl.click();
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
