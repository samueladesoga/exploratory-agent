// Turns a key name like "Enter", "Shift+Tab" or "Control+a" into Input.dispatchKeyEvent params.

interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const ALIASES: Record<string, string> = { Esc: "Escape", Return: "Enter", " ": "Space", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Del: "Delete" };

const MODIFIERS: Record<string, { bit: number; definition: KeyDefinition }> = {
  Alt: { bit: 1, definition: { key: "Alt", code: "AltLeft", keyCode: 18 } },
  Control: { bit: 2, definition: { key: "Control", code: "ControlLeft", keyCode: 17 } },
  Meta: { bit: 4, definition: { key: "Meta", code: "MetaLeft", keyCode: 91 } },
  Shift: { bit: 8, definition: { key: "Shift", code: "ShiftLeft", keyCode: 16 } },
};
const MODIFIER_ALIASES: Record<string, string> = { Ctrl: "Control", Cmd: "Meta", Command: "Meta", Option: "Alt" };

function definitionFor(name: string): KeyDefinition {
  const named = NAMED_KEYS[ALIASES[name] ?? name];
  if (named) return named;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
    return { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  }
  throw new Error(`Unknown key "${name}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}.`);
}

export function keyEvents(combo: string): Record<string, unknown>[] {
  const parts = combo === "+" ? ["+"] : combo.split("+").filter(Boolean);
  const modifierNames = parts.slice(0, -1).map((part) => MODIFIER_ALIASES[part] ?? part);
  for (const modifier of modifierNames) if (!MODIFIERS[modifier]) throw new Error(`Unknown modifier "${modifier}" in "${combo}".`);
  const main = definitionFor(parts[parts.length - 1] ?? "");
  const modifiers = modifierNames.reduce((bits, name) => bits | MODIFIERS[name].bit, 0);
  // Ctrl/Alt/Meta shortcuts don't type text.
  const text = modifiers & 7 ? undefined : main.text && modifiers & 8 ? main.text.toUpperCase() : main.text;
  const event = (type: string, definition: KeyDefinition, extra: object = {}) => ({
    type,
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    modifiers,
    ...extra,
  });

  return [
    ...modifierNames.map((name) => event("rawKeyDown", MODIFIERS[name].definition)),
    text ? event("keyDown", main, { text, unmodifiedText: main.text }) : event("rawKeyDown", main),
    event("keyUp", main),
    ...modifierNames.reverse().map((name) => event("keyUp", MODIFIERS[name].definition)),
  ];
}
