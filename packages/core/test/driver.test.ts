import assert from "node:assert/strict";
import { test } from "node:test";
import { SafetyPolicy, SignalBuffer } from "../src/index.js";
import { makeConfig } from "./fixtures.js";

test("blocks top-level navigation off the app's origins, but not subresources", () => {
  const policy = new SafetyPolicy(makeConfig());
  assert.equal(policy.blockReason("https://evil.test/", "GET", true), "navigation outside the allowed origins");
  assert.equal(policy.blockReason("https://cdn.test/app.js", "GET", false), undefined);
  assert.equal(policy.blockReason("https://app.example.com/cart", "GET", true), undefined);
  assert.equal(policy.blockReason("about:blank", "GET", true), undefined);
});

test("blockMutations blocks writes to the app only", () => {
  const policy = new SafetyPolicy(makeConfig({ safety: { blockMutations: true } }));
  assert.match(policy.blockReason("https://app.example.com/api/order", "post", false)!, /blockMutations/);
  assert.equal(policy.blockReason("https://app.example.com/api/order", "GET", false), undefined);
  assert.equal(policy.blockReason("https://analytics.test/collect", "POST", false), undefined);
});

test("blocks logout by default and honours method-specific rules", () => {
  const policy = new SafetyPolicy(makeConfig({ safety: { blockedRequests: [{ method: "delete", urlPattern: "/api/" }] } }));
  assert.match(policy.blockReason("https://app.example.com/api/items/1", "DELETE", false)!, /blockedRequests/);
  assert.equal(policy.blockReason("https://app.example.com/api/items/1", "GET", false), undefined);
  assert.match(new SafetyPolicy(makeConfig()).blockReason("https://app.example.com/Log-Out", "GET", true)!, /log-\?out/);
  assert.equal(policy.blockedMessage("https://app.example.com/a?token=secret", "post", "r"), "POST https://app.example.com/a blocked: r");
});

test("signal buffer drops ignored signals and shows each new one once", () => {
  const buffer = new SignalBuffer(makeConfig({ safety: { ignoreSignals: ["hotjar"] } }), () => "https://app.example.com/");
  buffer.push({ kind: "console-error", message: "hotjar failed to load" });
  buffer.push({ kind: "page-error", message: "TypeError: boom" });
  buffer.push({ kind: "page-error", message: "TypeError: boom" });
  buffer.note("A dialog appeared.");

  assert.equal(buffer.signals.length, 2);
  assert.equal(buffer.signals[0].pageUrl, "https://app.example.com/");
  assert.equal(buffer.drain(), "Note: A dialog appeared.\nRuntime signals since last step:\n- [page-error] TypeError: boom");
  assert.equal(buffer.drain(), "");
});
