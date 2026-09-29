// Formats Chrome's accessibility tree (Accessibility.getFullAXTree) into the same indented
// "- role "name"" outline the Playwright driver shows, with a [ref=eN] on every element the agent
// can act on. N is Chrome's backend DOM node id, which stays stable while the element exists.

export interface AxValue {
  type?: string;
  value?: unknown;
}

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value: AxValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "gridcell",
  "columnheader",
  "rowheader",
  "summary",
  "DisclosureTriangle",
]);

// Text fields: their children are the browser's internal editor, and the value is already shown.
const LEAF_ROLES = new Set(["textbox", "searchbox"]);

// Layout-only wrappers: their children are shown in their place.
const TRANSPARENT_ROLES = new Set(["generic", "none", "presentation", "LineBreak", "RootWebArea", "WebArea", "LabelText", "strong", "emphasis", "paragraph", "Section", "group"]);

const quote = (value: string) => `"${value.replace(/\s+/g, " ").trim().replace(/"/g, '\\"')}"`;

function property(node: AxNode, name: string): unknown {
  return node.properties?.find((prop) => prop.name === name)?.value.value;
}

function states(node: AxNode): string {
  const parts: string[] = [];
  const checked = property(node, "checked");
  if (checked === "true" || checked === true) parts.push("[checked]");
  else if (checked === "mixed") parts.push("[checked=mixed]");
  const pressed = property(node, "pressed");
  if (pressed === "true" || pressed === true) parts.push("[pressed]");
  if (property(node, "disabled") === true) parts.push("[disabled]");
  const expanded = property(node, "expanded");
  if (expanded === true) parts.push("[expanded]");
  else if (expanded === false) parts.push("[collapsed]");
  if (property(node, "selected") === true) parts.push("[selected]");
  if (property(node, "required") === true) parts.push("[required]");
  const invalid = property(node, "invalid");
  if (invalid && invalid !== "false") parts.push("[invalid]");
  const level = property(node, "level");
  if (node.role?.value === "heading" && level) parts.push(`[level=${level}]`);
  return parts.join(" ");
}

function isActionable(node: AxNode): boolean {
  const role = String(node.role?.value ?? "");
  return node.backendDOMNodeId !== undefined && (ACTIONABLE_ROLES.has(role) || property(node, "focusable") === true || property(node, "editable") !== undefined);
}

export function formatAxTree(nodes: AxNode[]): string {
  if (!nodes.length) return "(empty page)";
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const root = nodes.find((node) => !childIds.has(node.nodeId)) ?? nodes[0];
  const lines: string[] = [];

  const render = (node: AxNode, depth: number, parentName: string) => {
    const role = String(node.role?.value ?? "");
    const name = String(node.name?.value ?? "").trim();
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((child): child is AxNode => Boolean(child));
    const indent = "  ".repeat(depth);

    if (role === "InlineTextBox") return;
    if (role === "StaticText") {
      // Text inside a named control repeats the control's name.
      if (name && !parentName.includes(name)) lines.push(`${indent}- text: ${quote(name)}`);
      return;
    }
    const actionable = isActionable(node) && role !== "RootWebArea";
    if (node.ignored || role === "RootWebArea" || (TRANSPARENT_ROLES.has(role) && !actionable && !(name && role !== "RootWebArea" && role !== "generic" && role !== "none"))) {
      for (const child of children) render(child, depth, parentName);
      return;
    }

    const value = node.value?.value;
    const parts = [`${indent}- ${role}`];
    if (name) parts.push(quote(name));
    const stateText = states(node);
    if (stateText) parts.push(stateText);
    if (actionable) parts.push(`[ref=e${node.backendDOMNodeId}]`);
    let line = parts.join(" ");
    if (value !== undefined && value !== "" && value !== name) line += `: ${quote(String(value))}`;
    if (role === "Iframe") line += " (contents not shown)";
    lines.push(line);
    if (LEAF_ROLES.has(role)) return;
    for (const child of children) render(child, depth + 1, name);
  };

  render(root, 0, "");
  return lines.join("\n") || "(no accessible content)";
}
