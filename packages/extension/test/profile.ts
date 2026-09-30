// A fresh Chromium profile for tests that log in to saucedemo.com. Its password, secret_sauce, is in
// public breach lists, so Chrome's leak check sometimes opens a tab-modal "Change your password"
// dialog after login. The dialog swallows all mouse and keyboard input to the tab while its scripts
// keep running, so later clicks silently do nothing. Turning the check off keeps the tests stable.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function saucedemoProfile(prefix: string): Promise<string> {
  const profile = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(profile, "Default"));
  await writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({ profile: { password_manager_leak_detection: false } }));
  return profile;
}
