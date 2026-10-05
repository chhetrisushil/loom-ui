import { type StampedAction, viewedVersionOf } from "@loom-ui/core/browser";
import {
  type BindingStatus,
  type Layout,
  type Widget,
  type WidgetAction,
  asCell,
  isLayoutId,
  isLayoutRole,
  isWidget,
  resolveWidgetStatus,
  resolveWidgetValue,
} from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { titleText } from "../title";
import { deepEqual } from "./deepEqual";
import {
  type DomContainerChild,
  type DomContainerHandle,
  type DomContainerRegistry,
  type DomRegistry,
  type DomWidgetHandle,
  placeholderFor,
} from "./registry";

// ── The entry tree ────────────────────────────────────────────────────────────
// The adapter mounts a blueprint into a tree of ENTRIES that mirrors the DOM one-for-one: a
// `WidgetEntry` per widget host, a `ContainerEntry` per layout element. Mounting a blueprint and
// landing a revised one on the live tree are then the same shapes — the walk is here, once,
// instead of once inside a `traverseBlueprint` callback and again inside a reconciler.

export interface MountContext {
  readonly registry: DomRegistry;
  /** Container renderers keyed by role (IR 2.2.0); absent ⇒ every container is plain. */
  readonly containers?: DomContainerRegistry;
  readonly projectionRuntime: ProjectionRuntime;
  readonly executionId: string;
  /** Every projection the blueprint declares → its state; rebuilt by the caller before each mount/update. */
  readonly stateMap: Map<string, unknown>;
  /**
   * Called with every action a widget emits, AFTER the renderer has stamped it. Typed as
   * `StampedAction` (a `WidgetAction` plus `viewedVersion`), which a plain `(a: WidgetAction)`
   * handler accepts unchanged.
   */
  readonly onAction?: (action: StampedAction & WidgetAction) => void;
  /** The id of the Blueprint currently on screen — read at ACTION time, so it follows `update`. */
  readonly blueprintId?: () => string;
}

/**
 * The ONE place an action gets its provenance. The renderer, not the widget, owns `widgetId` and
 * `viewedVersion`: whatever a widget (or the A2UI tree / sandbox code behind it) put in those
 * top-level fields is overwritten, and their own data stays nested under `payload`.
 */
export function stampAction(
  action: WidgetAction,
  widget: Widget,
  ctx: MountContext
): StampedAction & WidgetAction {
  const status = resolveWidgetStatus(widget, ctx.stateMap);
  const binding = status && {
    state: status.state,
    ...(status.seq !== undefined && { seq: status.seq }),
  };
  return {
    type: action.type,
    widgetId: widget.id,
    ...(action.payload !== undefined && { payload: action.payload }),
    viewedVersion: viewedVersionOf(ctx.blueprintId?.() ?? "", binding),
  };
}
export interface WidgetEntry {
  readonly kind: "widget";
  /** `<div data-widget-id data-widget-kind>` — the grid item itself, no wrapper. */
  readonly host: HTMLElement;
  widget: Widget;
  /** Undefined while a placeholder is showing (no renderer for the kind, or the renderer threw). */
  handle: DomWidgetHandle | undefined;
  unsubscribe: (() => void) | undefined;
}
export interface ContainerEntry {
  readonly kind: "container";
  /** `<div data-layout>` — carries the layout style and holds the children (a renderer's `body`). */
  readonly el: HTMLElement;
  /**
   * What a title wraps: `el`, or — while a container renderer's chrome is live (IR 2.2.0) — the
   * `<div data-container-role>` role host holding the chrome and `el`.
   */
  inner: HTMLElement;
  /**
   * The element that sits in the PARENT: `inner` itself, or — for a layout with a non-empty
   * `title` (IR 2.1.0) — the `<section aria-label>` wrapping `<h2>` and `inner`. Grid placement
   * lands here.
   */
  outer: HTMLElement;
  /** The `<h2>` while the layout is titled. */
  heading: HTMLElement | undefined;
  layout: Layout;
  /**
   * The well-formed role this entry was mounted under (`roleKey`), part of its reconcile key:
   * containers match by layout id (IR 2.4.0, loom ADR 0101) or, without one, by ordinal among the
   * id-less siblings — plus type + role (loom ADR 0099 D3). Fixed for the entry's life.
   */
  readonly role: string | undefined;
  /** The live container renderer, if the role has one and it has not failed. */
  chrome: Chrome | undefined;
  /** Document order — the i-th entry is the i-th child element of `el`. */
  children: Entry[];
}
export interface Chrome {
  /** `<div data-container-role=R>` — chrome plus `el`. */
  readonly host: HTMLElement;
  readonly handle: DomContainerHandle;
  /** The child list the renderer was last handed — what the next pass compares against. */
  children: readonly DomContainerChild[];
}
export type Entry = WidgetEntry | ContainerEntry;
export interface ChildSpec {
  readonly node: Widget | Layout;
  readonly span: number;
  /** IR 2.1.0 placement (loom ADR 0098 D1) — present only when the cell sets it. */
  readonly row?: number;
  readonly rowSpan?: number;
  readonly column?: number;
}
export interface Slice {
  value: unknown;
  status: BindingStatus | undefined;
}

/**
 * Total over ANY input — loom's own `isWidget`. The old `"_tag" in n` threw on `undefined`, which
 * is exactly the node a malformed child list carries (`cell(4, undefined)`, a `[…, undefined]`).
 */
export const isWidgetNode = (n: Widget | Layout): n is Widget => isWidget(n);

const LAYOUT_TYPES = new Set(["grid", "flex", "stack"]);

/**
 * Every node under `layout` that is neither a widget nor a walkable layout, as a path from the
 * root (`layout.children[2].children[0]`). Iterative, like loom's walkers: a deep tree must not
 * blow the stack. `update` runs this over the WHOLE revised tree before it mutates anything —
 * loom's `blueprintNodeIds` skips malformed nodes without reporting them, so the identity walk
 * does not catch it, and a reconcile that met it half-way would already have mounted its siblings.
 */
export function malformedNodes(layout: unknown): string[] {
  const bad: string[] = [];
  const stack: Array<{ node: unknown; path: string }> = [{ node: layout, path: "layout" }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { node, path } = top;
    if (isWidget(node)) continue;
    const l = node as { type?: unknown; children?: unknown } | null;
    if (
      typeof l !== "object" ||
      l === null ||
      !LAYOUT_TYPES.has(l.type as string) ||
      !Array.isArray(l.children)
    ) {
      bad.push(path);
      continue;
    }
    const children = l.children as unknown[];
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i];
      const child =
        l.type === "grid" && typeof c === "object" && c !== null
          ? asCell(c as Widget | Layout).node
          : c;
      stack.push({ node: child, path: `${path}.children[${i}]` });
    }
  }
  return bad;
}

/** A layout's children with the cell each one occupies: span and placement under a grid, span 1 elsewhere. */
export function childSpecs(layout: Layout): ChildSpec[] {
  if (layout.type === "grid")
    return layout.children.map((c) => {
      const cell = asCell(c);
      return {
        node: cell.node,
        span: cell.span ?? 1,
        ...(cell.row !== undefined && { row: cell.row }),
        ...(cell.rowSpan !== undefined && { rowSpan: cell.rowSpan }),
        ...(cell.column !== undefined && { column: cell.column }),
      };
    });
  return layout.children.map((node) => ({ node, span: 1 }));
}

// Both writers below assign ONLY when the value actually differs. Setting an attribute or a
// style property to the value it already holds is a no-op to the reader but a real record to a
// `MutationObserver` — and these two run over every container and every child on every `update`.
// Guarding them is what makes "an identical Blueprint mutates nothing" literally true rather
// than merely invisible.
type StyleProp = "display" | "gridTemplateColumns" | "flexDirection" | "gap";
const setStyle = (el: HTMLElement, prop: StyleProp, value: string): void => {
  if (el.style[prop] !== value) el.style[prop] = value;
};

/**
 * IR 2.1.0: a cell's span AND placement land on the child's own element — no wrapper — as the
 * CSS grid lines loom's React renderer writes on its cell wrapper (loom ADR 0098 D4):
 * `grid-column` is `<column> / span <span>`, or `span <span>` for an unplaced span > 1 or any
 * placed cell; `grid-row` is `<row> / span <rowSpan ?? 1>`, or `span <rowSpan>`, or nothing. An
 * unplaced span-1 cell writes nothing (2.0.0's DOM, unchanged), and outside a grid both are
 * cleared. Written only on change, so an unchanged cell costs zero mutations and a placement
 * change is a style patch on the kept element, never a remount.
 */
export function applyPlacement(el: HTMLElement, spec: ChildSpec, inGrid: boolean): void {
  const placed = spec.row !== undefined || spec.rowSpan !== undefined || spec.column !== undefined;
  const column = !inGrid
    ? ""
    : spec.column !== undefined
      ? `${spec.column} / span ${spec.span}`
      : placed || spec.span > 1
        ? `span ${spec.span}`
        : "";
  const row = !inGrid
    ? ""
    : spec.row !== undefined
      ? `${spec.row} / span ${spec.rowSpan ?? 1}`
      : spec.rowSpan !== undefined
        ? `span ${spec.rowSpan}`
        : "";
  if (el.style.gridColumn !== column) el.style.gridColumn = column;
  if (el.style.gridRow !== row) el.style.gridRow = row;
}

/** The container element's own styling, derived only from the layout node. Idempotent. */
export function styleContainer(el: HTMLElement, layout: Layout): void {
  if (el.dataset.layout !== layout.type) el.dataset.layout = layout.type;
  if (layout.type === "grid") {
    setStyle(el, "display", "grid");
    setStyle(el, "gridTemplateColumns", `repeat(${layout.columns}, 1fr)`);
    setStyle(el, "flexDirection", "");
  } else {
    setStyle(el, "display", "flex");
    setStyle(el, "gridTemplateColumns", "");
    setStyle(el, "flexDirection", layout.type === "flex" ? layout.direction : "column");
  }
  setStyle(el, "gap", layout.gap !== undefined ? `${layout.gap}px` : "");
}

/**
 * The role a layout is keyed and looked up under: a well-formed role (loom's `isLayoutRole`,
 * ADR 0099 D2), else none. A malformed role is exactly an absent one here — the renderer never
 * throws on it and never half-honours it — so `"Stepped"` or `"__proto__"` can reach no registry.
 */
export function roleKey(layout: Layout): string | undefined {
  const role = (layout as { role?: unknown }).role;
  return isLayoutRole(role) ? role : undefined;
}

/**
 * The `nodeId` a container-level finding carries: the layout's id when it has a well-formed one
 * (loom's `isLayoutId`, IR 2.4.0, ADR 0101 D3), else `""` — a layout without an id has none.
 */
export function layoutNodeId(layout: Layout): string {
  const id = (layout as { id?: unknown }).id;
  return isLayoutId(id) ? id : "";
}

/** A layout's heading: a NON-EMPTY string title, or none — the rule loom's React and terminal renderers apply (ADR 0098 D4). */
export function titleOf(layout: Layout): string | undefined {
  return titleText(layout.title);
}

/**
 * A titled layout renders as loom's React renderer draws it (ADR 0098 D4):
 * `<section aria-label=T><h2>T</h2>` + the layout element (or, under a container renderer, its
 * role host — so the heading names chrome and body alike). The layout style stays on the inner
 * element, so the heading is never a grid item; the SECTION is what sits in the parent (and
 * carries the parent's grid lines). Always `h2`: the blueprint title is the `h1`. `aria-label`
 * names the region — a `<section>` does not take its accessible name from its heading.
 *
 * Idempotent and change-guarded. A text change patches the heading and the label. Adding or
 * removing a title WRAPS or UNWRAPS the same layout element in place: its widgets stay mounted
 * (no dispose, no render). The move uses `moveBefore` where the platform has it (a
 * state-preserving move: nothing is blurred); otherwise a plain move blurs a focused control
 * inside the subtree, so that control's focus and text selection are captured before and
 * restored after — the DEEP control, inside the widget's shadow root, not its host. Placement
 * styles are cleared from the inner element on wrap; the parent's pass writes them on whichever
 * element now sits in the grid.
 */
export function applyTitle(entry: ContainerEntry, layout: Layout): void {
  const title = titleOf(layout);
  // The element the section wraps: the layout element, or its role host while chrome is live.
  const el = entry.inner;
  if (title !== undefined && entry.heading !== undefined) {
    if (entry.heading.textContent !== title) entry.heading.textContent = title;
    if (entry.outer.getAttribute("aria-label") !== title)
      entry.outer.setAttribute("aria-label", title);
    return;
  }
  if (title === undefined && entry.heading === undefined) return;
  const restore = focusWithin(el);
  if (title !== undefined) {
    const section = document.createElement("section");
    section.setAttribute("aria-label", title);
    const heading = document.createElement("h2");
    heading.textContent = title;
    if (el.style.gridColumn !== "") el.style.gridColumn = "";
    if (el.style.gridRow !== "") el.style.gridRow = "";
    // A fresh mount has no parent yet: the section is simply built around `el`.
    el.parentNode?.insertBefore(section, el);
    section.append(heading);
    moveInto(section, el, null);
    entry.outer = section;
    entry.heading = heading;
  } else {
    const outer = entry.outer;
    const parent = outer.parentNode;
    if (parent !== null) moveInto(parent, el, outer);
    else el.remove();
    outer.remove();
    entry.outer = el;
    entry.heading = undefined;
  }
  restore();
}

type MoveBefore = (node: Node, child: Node | null) => void;

/**
 * Move `node` under `parent` before `before`, state-preserving where the platform supports
 * `moveBefore` (both ends connected to the same document); a plain insert otherwise.
 */
function moveInto(parent: ParentNode & Node, node: Node, before: Node | null): void {
  const moveBefore = (parent as { moveBefore?: MoveBefore }).moveBefore;
  if (typeof moveBefore === "function" && parent.isConnected && node.isConnected) {
    try {
      moveBefore.call(parent, node, before);
      return;
    } catch {
      // A move the platform refuses (e.g. across roots) falls back to a plain insert.
    }
  }
  parent.insertBefore(node, before);
}

/**
 * Capture the focused control under `root` (and its text selection) so a DOM move can hand both
 * back. Widgets render into shadow roots, where `document.activeElement` is only the HOST; the
 * control that holds focus and selection is found by descending through each shadow root's own
 * `activeElement`. Containment is checked on the top-level host (it is what sits under `root`);
 * focus and selection are restored on the deep element.
 */
function focusWithin(root: HTMLElement): () => void {
  const top = document.activeElement;
  if (!(top instanceof HTMLElement) || !root.contains(top)) return () => {};
  let active: Element = top;
  while (active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  // A deep control that is not an HTMLElement (a focused SVG in a shadow root) cannot be
  // restored through this path; refocus its top-level host instead of dropping focus.
  const deep = active instanceof HTMLElement ? active : top;
  const field =
    deep instanceof HTMLTextAreaElement || deep instanceof HTMLInputElement ? deep : undefined;
  let range: [number | null, number | null, "forward" | "backward" | "none" | null] = [
    null,
    null,
    null,
  ];
  try {
    if (field) range = [field.selectionStart, field.selectionEnd, field.selectionDirection];
  } catch {
    // Input types without a selection (number, date, …) throw here; focus alone is restored.
  }
  return () => {
    if (deep === top ? document.activeElement !== top : deepActive() !== deep)
      deep.focus({ preventScroll: true });
    const [start, end, direction] = range;
    if (field && start !== null && end !== null) {
      try {
        if (
          field.selectionStart !== start ||
          field.selectionEnd !== end ||
          (direction !== null && field.selectionDirection !== direction)
        )
          field.setSelectionRange(start, end, direction ?? undefined);
      } catch {
        // Same: a type without a selection API.
      }
    }
  };
}

/** The focused element, descended through every open shadow root on the way. */
function deepActive(): Element | null {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// A bound widget's slice, resolved the way loom resolves it: value AND status both come from
// the binding's own paths in the SAME projection state (IR 2.0.0), so this adapter knows
// nothing about handles or a hydration-shaped state. `resolveWidgetStatus` returns undefined
// for a binding with no `status.path` (the channel is opt-in) and for anything that is not a
// `BindingStatus` — including the `Object.prototype` a `status.__proto__` path resolves to.
//
// `subscribeSelector` calls the selector on every event, so the one-entry state map each
// widget hands loom is allocated ONCE per widget and rewritten in place, not per call.
const sliceSelector = (widget: Widget, projectionId: string): ((state: unknown) => Slice) => {
  const map = new Map<string, unknown>();
  return (state) => {
    map.set(projectionId, state);
    return { value: resolveWidgetValue(widget, map), status: resolveWidgetStatus(widget, map) };
  };
};

/**
 * Two slices are the same UPDATE when the value is unchanged and the status has not moved.
 *
 * `seq` is the cheap answer, but it is OPTIONAL on loom's `BindingStatus` (IR 2.0.0) — only the
 * hydration store happens to stamp one. Comparing `a.status?.seq === b.status?.seq` alone would
 * call every seq-less status pair equal, silently dropping exactly the transition the status
 * matrix exists for: "the provider failed, keep the last value" is `ready` → `error` over an
 * UNCHANGED value, and `undefined` → `{ state: "error" }` compares equal too (both `undefined`).
 * So `seq` decides only when it is actually present; otherwise the statuses must be the same
 * object. A producer that rebuilds an equal status object each event re-renders needlessly —
 * the safe direction to be wrong in.
 */
export function sliceIsEqual(a: Slice, b: Slice): boolean {
  if (a.value !== b.value) return false;
  if (a.status === b.status) return true;
  return a.status?.seq !== undefined && a.status.seq === b.status?.seq;
}

/**
 * Degrade a live widget to its error placeholder: the host's content is the placeholder alone.
 *
 * This TEARS THE WIDGET DOWN, it does not merely hide it. Dropping `entry.handle` on its own
 * would leave the subscription closure — which closes over the destructured `handle`, not over
 * `entry` — pushing slices into a renderer that has already failed, and would leak whatever the
 * handle holds because nothing ever calls `dispose()` on it. So: unsubscribe first (that is what
 * stops further `update` calls), then dispose. Both in `try`/`catch`: a renderer that threw once
 * may well throw again, and the placeholder must go up regardless.
 */
export function showError(entry: WidgetEntry, message: string): void {
  try {
    entry.unsubscribe?.();
  } catch {
    // A failing unsubscribe must not stop the teardown.
  }
  try {
    entry.handle?.dispose();
  } catch {
    // Ditto — the handle is dropped either way, so it is never disposed twice.
  }
  entry.unsubscribe = undefined;
  entry.handle = undefined;
  entry.host.replaceChildren(placeholderFor(entry.widget.kind, "error", message));
}

/** (Re)subscribe a widget to its binding's projection. Drops any previous subscription first. */
export function subscribeEntry(entry: WidgetEntry, ctx: MountContext): void {
  entry.unsubscribe?.();
  entry.unsubscribe = undefined;
  const { widget, handle } = entry;
  if (!widget.binding || !handle) return;
  const off = ctx.projectionRuntime.subscribeSelector<unknown, Slice>(
    widget.binding.projectionId,
    ctx.executionId,
    sliceSelector(widget, widget.binding.projectionId),
    (slice) => {
      try {
        handle.update(slice.value, slice.status);
      } catch (e) {
        showError(entry, e instanceof Error ? e.message : String(e));
      }
    },
    sliceIsEqual
  );
  entry.unsubscribe = off;
}

/** Run the widget's renderer into an EMPTY host. Placeholders on a missing renderer or a throw. */
export function renderInto(
  entry: WidgetEntry,
  ctx: MountContext,
  onFail: (f: { nodeId: string; message: string }) => void
): void {
  const { widget, host } = entry;
  // The host is cleared unconditionally, so a REMOUNT in place needs no caller discipline: every
  // path below (placeholder, renderer output, error) starts from an empty host.
  host.replaceChildren();
  // Set BEFORE the lookup: a kind with no renderer still labels its host with the kind it wanted.
  host.dataset.widgetKind = widget.kind;
  const renderer = ctx.registry.get(widget.kind);
  if (!renderer) {
    host.replaceChildren(placeholderFor(widget.kind, "missing"));
    entry.handle = undefined;
    // A missing renderer is a REPORTED failure, not a silent one: a widget the new blueprint
    // added of a kind nobody registered lands in `RecomposeReport.findings` as `mount-failed`.
    // The initial mount passes a no-op `onFail`, so mount behaviour is unchanged.
    onFail({ nodeId: widget.id, message: `no renderer for "${widget.kind}"` });
    return;
  }
  const value = resolveWidgetValue(widget, ctx.stateMap);
  const status = resolveWidgetStatus(widget, ctx.stateMap);
  try {
    const handle = renderer(host, {
      widget,
      value,
      ...(status && { status }),
      ...(ctx.onAction && {
        onAction: (a: WidgetAction) => ctx.onAction?.(stampAction(a, widget, ctx)),
      }),
    });
    if (!handle || typeof handle.update !== "function")
      throw new Error("renderer returned no handle");
    entry.handle = handle;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showError(entry, message);
    onFail({ nodeId: widget.id, message });
    return;
  }
  subscribeEntry(entry, ctx);
}

/**
 * Called with every entry a mount creates, BEFORE its renderer runs — so a caller can undo a
 * mount that throws half-way (a refused subscribe after the renderer already returned a handle).
 */
export type TrackMount = (entry: Entry) => void;

export function mountWidget(
  widget: Widget,
  ctx: MountContext,
  onFail: (f: { nodeId: string; message: string }) => void,
  track?: TrackMount
): WidgetEntry {
  const host = document.createElement("div");
  host.dataset.widgetId = widget.id;
  const entry: WidgetEntry = {
    kind: "widget",
    host,
    widget,
    handle: undefined,
    unsubscribe: undefined,
  };
  track?.(entry);
  renderInto(entry, ctx, onFail);
  return entry;
}

/**
 * Mount `layout`. `path` names it from the blueprint root (`layout.children[1]`) — used only in a
 * container renderer's failure message, beside the layout's id when it has one (`layoutNodeId`).
 */
export function mountContainer(
  layout: Layout,
  ctx: MountContext,
  onFail: (f: { nodeId: string; message: string }) => void,
  track?: TrackMount,
  path = "layout"
): ContainerEntry {
  const el = document.createElement("div");
  styleContainer(el, layout);
  const inGrid = layout.type === "grid";
  const entry: ContainerEntry = {
    kind: "container",
    el,
    inner: el,
    outer: el,
    heading: undefined,
    layout,
    role: roleKey(layout),
    chrome: undefined,
    children: [],
  };
  track?.(entry);
  childSpecs(layout).forEach((spec, i) => {
    const { node } = spec;
    const child = isWidgetNode(node)
      ? mountWidget(node, ctx, onFail, track)
      : mountContainer(node, ctx, onFail, track, `${path}.children[${i}]`);
    const childEl = elementOf(child);
    applyPlacement(childEl, spec, inGrid);
    el.appendChild(childEl);
    entry.children.push(child);
  });
  // Chrome after the children (the renderer is handed them), the title after the chrome (the
  // section wraps the role host, so the heading names chrome and body alike).
  mountChrome(entry, ctx, onFail, path);
  applyTitle(entry, layout);
  return entry;
}

// ── Container renderers (IR 2.2.0 `Layout.role`, loom ADR 0099) ─────────────────────────────

/** The children a container renderer is handed: document order, each element with its node. */
export function containerChildren(entry: ContainerEntry): DomContainerChild[] {
  return entry.children.map((c) => ({
    element: elementOf(c),
    node: c.kind === "widget" ? c.widget : c.layout,
  }));
}

const withoutChildren = (layout: Layout): Omit<Layout, "children"> => {
  const { children: _children, ...own } = layout;
  return own;
};

/** A layout's OWN fields — everything but `children` (type, columns, direction, gap, title, role). */
export function ownFieldsEqual(a: Layout, b: Layout): boolean {
  return deepEqual(withoutChildren(a), withoutChildren(b));
}

/**
 * Whether a container renderer must hear about `next`: a child element added, removed, replaced
 * or reordered, or a child's own fields changed (a widget node, or a child layout's own fields —
 * a step's title is a label the chrome shows). Children's SUBTREES are not compared: what moves
 * inside a step is the adapter's business alone.
 */
export function childrenChanged(
  prev: readonly DomContainerChild[],
  next: readonly DomContainerChild[]
): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i] as DomContainerChild;
    const b = next[i] as DomContainerChild;
    if (a.element !== b.element) return true;
    if (a.node === b.node) continue;
    const aw = isWidgetNode(a.node);
    if (aw !== isWidgetNode(b.node)) return true;
    if (aw ? !deepEqual(a.node, b.node) : !ownFieldsEqual(a.node as Layout, b.node as Layout))
      return true;
  }
  return false;
}

/**
 * Undo what an app may have set on a child to hide it. Called when chrome is dropped after a
 * failure: the plain container that replaces it shows every child, so a child the chrome had
 * hidden must not stay hidden with nothing left to show it again.
 */
function unhide(children: readonly DomContainerChild[]): void {
  for (const { element } of children)
    for (const attr of ["hidden", "inert", "aria-hidden"])
      if (element.hasAttribute(attr)) element.removeAttribute(attr);
}

const failureMessage = (role: string, path: string, e: unknown): string =>
  `container renderer for role "${role}" at ${path} failed: ${e instanceof Error ? e.message : String(e)}`;

/**
 * Run the container renderer registered for the entry's role, if any, around the fresh `el`. A
 * renderer that throws, or returns no handle with `update` and `dispose`, is reported through
 * `onFail` and the container stays plain — `el` never left the adapter's hands.
 */
function mountChrome(
  entry: ContainerEntry,
  ctx: MountContext,
  onFail: (f: { nodeId: string; message: string }) => void,
  path: string
): void {
  const role = entry.role;
  if (role === undefined) return;
  const renderer = ctx.containers?.get(role);
  if (renderer === undefined) return;
  const host = document.createElement("div");
  host.dataset.containerRole = role;
  host.append(entry.el);
  const children = containerChildren(entry);
  try {
    const handle = renderer(host, { layout: entry.layout, body: entry.el, children });
    if (
      !handle ||
      typeof handle.update !== "function" ||
      typeof (handle as { dispose?: unknown }).dispose !== "function"
    ) {
      try {
        (handle as { dispose?: () => void } | undefined)?.dispose?.();
      } catch {
        // Refused either way.
      }
      throw new Error("the renderer returned no handle with update() and dispose()");
    }
    entry.chrome = { host, handle, children };
    entry.inner = host;
    entry.outer = host;
  } catch (e) {
    entry.el.remove(); // out of the discarded role host; the parent places it
    unhide(children);
    onFail({ nodeId: layoutNodeId(entry.layout), message: failureMessage(role, path, e) });
  }
}

/**
 * Hand a live chrome the container's current state, iff anything it is told about changed
 * (`ownFieldsEqual`, `childrenChanged`) — an identical Blueprint calls nothing. A throwing
 * `update` drops the chrome (`dropChrome`) and returns the failure message.
 */
export function updateChrome(
  entry: ContainerEntry,
  prevLayout: Layout,
  path: string
): string | undefined {
  const chrome = entry.chrome;
  if (chrome === undefined) return undefined;
  const children = containerChildren(entry);
  if (ownFieldsEqual(prevLayout, entry.layout) && !childrenChanged(chrome.children, children))
    return undefined;
  try {
    chrome.handle.update({ layout: entry.layout, body: entry.el, children });
    chrome.children = children;
    return undefined;
  } catch (e) {
    dropChrome(entry);
    return failureMessage(entry.role ?? "", path, e);
  }
}

/**
 * Fall back from a failed chrome to the plain container, in place: dispose the handle, move `el`
 * to where the role host stood (inside the section when titled, else in the parent), drop the
 * host, un-hide every child. Children stay mounted and subscribed; focus inside is kept. The
 * entry keeps its role (its KEY), so the same role is not retried until the container remounts.
 */
function dropChrome(entry: ContainerEntry): void {
  const chrome = entry.chrome;
  if (chrome === undefined) return;
  entry.chrome = undefined;
  try {
    chrome.handle.dispose();
  } catch {
    // Already failing: the chrome is dropped either way.
  }
  const { host } = chrome;
  const restore = focusWithin(host);
  const parent = host.parentNode;
  if (parent !== null) moveInto(parent, entry.el, host);
  else entry.el.remove();
  host.remove();
  unhide(containerChildren(entry));
  if (entry.outer === host) entry.outer = entry.el;
  entry.inner = entry.el;
  restore();
}

/**
 * Unsubscribe and dispose every widget under `entry` — and every container renderer's chrome —
 * reporting each failure against the WIDGET id it came from (for chrome, the layout's id when it
 * has one, else `""` — `layoutNodeId`). Leaves the DOM in place.
 * Idempotent: a disposed widget has no handle or subscription left to dispose again.
 */
export function disposeEntry(entry: Entry, onError: (widgetId: string, e: unknown) => void): void {
  if (entry.kind === "container") {
    // A container renderer's chrome goes first (it wraps the children); a throw is blamed on the
    // layout's id, or "" without one. Dropped from the entry so a second dispose does not repeat it.
    const chrome = entry.chrome;
    entry.chrome = undefined;
    try {
      chrome?.handle.dispose();
    } catch (e) {
      onError(layoutNodeId(entry.layout), e);
    }
    for (const c of entry.children) disposeEntry(c, onError);
    return;
  }
  try {
    entry.unsubscribe?.();
  } catch (e) {
    onError(entry.widget.id, e);
  }
  entry.unsubscribe = undefined;
  try {
    entry.handle?.dispose();
  } catch (e) {
    onError(entry.widget.id, e);
  }
  entry.handle = undefined;
}

export function widgetIdsOf(entry: Entry): string[] {
  return entry.kind === "widget" ? [entry.widget.id] : entry.children.flatMap(widgetIdsOf);
}

/** The element an entry puts in its parent: a widget's host, or a container's `outer` (its section when titled, else its role host under chrome, else `el`). */
export const elementOf = (entry: Entry): HTMLElement =>
  entry.kind === "widget" ? entry.host : entry.outer;
