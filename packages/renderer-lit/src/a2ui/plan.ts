/**
 * A2UI declarative view model (Google Agent-to-UI v1.0), the browser-safe half.
 *
 * A view is an adjacency-list component tree (relationships by id reference, never
 * nesting; exactly one node has `id: "root"`) drawn from a catalog vocabulary and
 * bound to a data model by JSON Pointer. genUI renders it generically — the same
 * shape the server-side `@loom/plugin-a2ui` catalog describes — so a component
 * type with no bespoke renderer (e.g. a user-registered one) can still be drawn
 * from primitives. This module is the PURE core (types + binding resolution); the
 * Lit element in `@genui/widgets-lit` walks the tree with it.
 *
 * A prop is either a literal value or a data binding `{ path: "<JSON Pointer>" }`.
 */

/** A data binding into the view's data model, addressed by RFC 6901 JSON Pointer. */
export interface A2UIBinding {
  path: string;
}

/** One node in the adjacency-list component tree. Type-specific props (e.g. a
 * Text's `text`) sit alongside `id`/`component`; each may be a literal or binding.
 * Container children are referenced by id in `children` (a string[] for
 * Row/Column, or a `{ path, componentId }` template for a data-bound List). */
export interface A2UINode {
  id: string;
  component: string;
  [prop: string]: unknown;
}

/** A renderable A2UI view: the component tree plus the catalog it draws from. */
export interface A2UIView {
  /** The catalog these `component` types resolve in (e.g. "genui.widgets.v1"). */
  catalogId?: string;
  /** Adjacency-list nodes; exactly one must have `id: "root"`. */
  nodes: A2UINode[];
}

/** The data-bound List child template: iterate the array at `path`, rendering
 * `componentId` once per element (relative bindings resolve against the element). */
export interface A2UIListChildren {
  path: string;
  componentId: string;
}

export function isBinding(value: unknown): value is A2UIBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    Object.keys(value as object).length === 1
  );
}

export function isListChildren(value: unknown): value is A2UIListChildren {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { componentId?: unknown }).componentId === "string"
  );
}

// ── JSON Pointer (RFC 6901) resolution ─────────────────────────────────────────
// "" addresses the whole document; "/a/b" walks keys/indices; "~1"→"/", "~0"→"~".

function unescapeSegment(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolve an RFC 6901 JSON Pointer against `doc`; `undefined` if the path is
 * absent or walks through a non-object. `""` returns the whole document. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (pointer[0] !== "/") return undefined; // not a valid pointer
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    if (cur === null || typeof cur !== "object") return undefined;
    const key = unescapeSegment(raw);
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

/** Resolve a single prop value: a binding reads the data model, a literal passes
 * through. `scope` (the current List element) takes precedence over the root
 * `data` for relative resolution, matching A2UI collection scope. */
export function resolveProp(value: unknown, data: unknown, scope?: unknown): unknown {
  if (!isBinding(value)) return value;
  if (scope !== undefined) {
    const scoped = resolvePointer(scope, value.path);
    if (scoped !== undefined) return scoped;
  }
  return resolvePointer(data, value.path);
}

// ── Tree helpers ────────────────────────────────────────────────────────────────

export function nodeById(view: A2UIView, id: string): A2UINode | undefined {
  return view.nodes.find((n) => n.id === id);
}

export function rootNode(view: A2UIView): A2UINode | undefined {
  return nodeById(view, "root");
}

/** Resolve every non-structural prop of a node against the data model. `id`,
 * `component`, and `children` are structural and excluded. */
export function resolveNodeProps(
  node: A2UINode,
  data: unknown,
  scope?: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "id" || key === "component" || key === "children") continue;
    out[key] = resolveProp(value, data, scope);
  }
  return out;
}

// ── Render plan ─────────────────────────────────────────────────────────────────
// The whole tree walked into a plain, renderer-agnostic structure: which
// primitive each node becomes, its resolved display text, and its children.
// Keeping this pure (no DOM) makes the interpreter's decisions — the primitive
// switch, child resolution, List iteration/scoping, cycle guarding — unit-testable
// in isolation; the Lit element is then a thin, low-risk map from plan to DOM.

export type A2UIRender =
  | { kind: "text"; text: string }
  | { kind: "badge"; label: string; tone: string }
  | { kind: "row"; children: A2UIRender[] }
  | { kind: "column"; children: A2UIRender[] }
  | { kind: "list"; children: A2UIRender[] }
  | { kind: "button"; label: string; action: string; context: unknown }
  | { kind: "unknown"; component: string }
  | { kind: "empty" };

/** Format a resolved prop value as display text (objects stringify — A2UI
 * DynamicString behavior for a non-string bound to an object). */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Walk one node into a render plan. `scope` is the current List element (relative
 * binding scope); `seen` guards against reference cycles in the adjacency list. */
export function planNode(
  view: A2UIView,
  node: A2UINode,
  data: unknown,
  scope?: unknown,
  seen: ReadonlySet<string> = new Set()
): A2UIRender {
  if (seen.has(node.id)) return { kind: "empty" }; // cycle guard
  const guard = new Set(seen).add(node.id);
  const props = resolveNodeProps(node, data, scope);

  const planChild = (id: unknown): A2UIRender | undefined => {
    if (typeof id !== "string") return undefined;
    const child = nodeById(view, id);
    return child ? planNode(view, child, data, scope, guard) : undefined;
  };
  const idChildren = (): A2UIRender[] =>
    (Array.isArray(node.children) ? (node.children as unknown[]) : [])
      .map(planChild)
      .filter((c): c is A2UIRender => c !== undefined);

  switch (node.component) {
    case "Text":
      return { kind: "text", text: formatValue(props.text) };
    case "Badge":
      return {
        kind: "badge",
        label: formatValue(props.label ?? props.text),
        tone: typeof props.tone === "string" ? props.tone : "",
      };
    case "Column":
      return { kind: "column", children: idChildren() };
    case "Row":
      return { kind: "row", children: idChildren() };
    case "List": {
      if (!isListChildren(node.children)) return { kind: "list", children: [] };
      const { path, componentId } = node.children;
      const items = resolvePointer(data, path);
      const template = nodeById(view, componentId);
      if (!Array.isArray(items) || !template) return { kind: "list", children: [] };
      return {
        kind: "list",
        children: items.map((item) => planNode(view, template, data, item, guard)),
      };
    }
    case "Button":
      return {
        kind: "button",
        label: formatValue(props.label ?? props.text),
        action: typeof props.action === "string" ? props.action : "",
        context: scope,
      };
    default:
      return { kind: "unknown", component: node.component };
  }
}

/** Walk a whole view into a render plan, starting at the `root` node. */
export function planView(view: A2UIView, data: unknown): A2UIRender {
  const root = rootNode(view);
  if (!root) return { kind: "empty" };
  return planNode(view, root, data);
}
