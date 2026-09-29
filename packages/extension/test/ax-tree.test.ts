import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAxTree, type AxNode } from "../src/ax-tree.js";
import { keyEvents } from "../src/keys.js";

const node = (nodeId: string, role: string, name = "", extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
});

test("formats the tree with refs on actionable elements only", () => {
  const nodes: AxNode[] = [
    node("1", "RootWebArea", "Shop", { childIds: ["2", "3", "9"] }),
    node("2", "heading", "Products", { childIds: ["20"], properties: [{ name: "level", value: { value: 1 } }], backendDOMNodeId: 11 }),
    node("20", "StaticText", "Products"),
    node("3", "generic", "", { childIds: ["4", "5", "6", "7"] }),
    node("4", "button", "Add to cart", { backendDOMNodeId: 42, childIds: ["40"], properties: [{ name: "focusable", value: { value: true } }] }),
    node("40", "StaticText", "Add to cart", { childIds: ["41"] }),
    node("41", "InlineTextBox", "Add to cart"),
    node("5", "textbox", "Email", { backendDOMNodeId: 57, value: { value: "a@b.c" }, properties: [{ name: "required", value: { value: true } }, { name: "invalid", value: { value: "true" } }] }),
    node("6", "checkbox", "Remember me", { backendDOMNodeId: 60, properties: [{ name: "checked", value: { value: "true" } }, { name: "disabled", value: { value: true } }] }),
    node("7", "StaticText", "Free delivery over £50"),
    node("9", "none", "", { ignored: true, childIds: ["10"] }),
    node("10", "link", 'Say "hi"', { backendDOMNodeId: 70 }),
  ];
  assert.equal(
    formatAxTree(nodes),
    [
      '- heading "Products" [level=1]',
      '- button "Add to cart" [ref=e42]',
      '- textbox "Email" [required] [invalid] [ref=e57]: "a@b.c"',
      '- checkbox "Remember me" [checked] [disabled] [ref=e60]',
      '- text: "Free delivery over £50"',
      '- link "Say \\"hi\\"" [ref=e70]',
    ].join("\n"),
  );
});

test("nests children under named containers and handles empty trees", () => {
  const nodes: AxNode[] = [
    node("1", "RootWebArea", "", { childIds: ["2"] }),
    node("2", "navigation", "Main", { childIds: ["3"] }),
    node("3", "link", "Pricing", { backendDOMNodeId: 5 }),
  ];
  assert.equal(formatAxTree(nodes), '- navigation "Main"\n  - link "Pricing" [ref=e5]');
  assert.equal(formatAxTree([]), "(empty page)");
});

test("key combos become CDP key events", () => {
  const [enterDown, enterUp] = keyEvents("Enter");
  assert.deepEqual(enterDown, { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
  assert.equal(enterUp.type, "keyUp");

  const shiftTab = keyEvents("Shift+Tab");
  assert.deepEqual(shiftTab.map((event) => `${event.type}:${event.key}`), ["rawKeyDown:Shift", "rawKeyDown:Tab", "keyUp:Tab", "keyUp:Shift"]);
  assert.equal(shiftTab[1].modifiers, 8);

  const selectAll = keyEvents("Ctrl+a");
  assert.equal(selectAll[1].type, "rawKeyDown", "shortcuts don't type text");
  assert.equal(selectAll[1].code, "KeyA");
  assert.equal(keyEvents("Esc")[0].key, "Escape");
  assert.equal(keyEvents("5")[0].code, "Digit5");
  assert.throws(() => keyEvents("Hyper+x"), /Unknown modifier/);
  assert.throws(() => keyEvents("F13"), /Unknown key "F13"/);
});
