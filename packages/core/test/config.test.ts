import assert from "node:assert/strict";
import { test } from "node:test";
import { appOrigins, parseClientConfigYaml } from "../src/index.js";
import { makeConfig } from "./fixtures.js";

test("fills in defaults for a minimal config", () => {
  const cfg = makeConfig();
  assert.equal(cfg.auth.type, "none");
  assert.equal(cfg.safety.blockMutations, false);
  assert.deepEqual(cfg.safety.blockedRequests, [{ urlPattern: "log-?out|sign-?out" }]);
  assert.equal(cfg.run.sessions, 5);
  assert.equal(cfg.run.plannerModel, "opus");
  assert.equal(cfg.run.explorerModel, "sonnet");
});

test("parses YAML and names the source and field in errors", () => {
  const cfg = parseClientConfigYaml("name: Shop\nbaseUrl: https://shop.test\ndescription: A shop\nrun:\n  sessions: 2\n", "shop.yaml");
  assert.equal(cfg.run.sessions, 2);
  assert.throws(() => parseClientConfigYaml("name: Shop\nbaseUrl: not-a-url\ndescription: A shop\n", "shop.yaml"), /Invalid client config shop\.yaml:\n {2}- baseUrl:/);
});

test("app origins include the base URL, allowed origins and the login page", () => {
  const cfg = makeConfig({
    allowedOrigins: ["https://api.example.com/v1"],
    auth: { type: "form", loginUrl: "https://login.example.com/sso", usernameEnv: "U", passwordEnv: "P" },
  });
  assert.deepEqual([...appOrigins(cfg)].sort(), ["https://api.example.com", "https://app.example.com", "https://login.example.com"]);
});
