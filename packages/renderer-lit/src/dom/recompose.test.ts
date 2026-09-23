import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import {
  type Blueprint,
  type DataBinding,
  MetricCard,
  RendererRegistry,
  StatusBadge,
  type Widget,
  blueprint$,
  cell,
  flex,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { type DomWidgetRenderer, type RecomposeReport, renderBlueprintDom } from "./index";
import { isWidgetNode } from "./tree";

const bind = (handle: string): DataBinding => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
  status: { path: hydrationStatusPath(handle) },
});

/** A renderer that records calls, renders `<span>` text, and — for NoteInput — a real textarea. */
const recording = (withPatch = true) => {
  const calls: string[] = [];
  const plain: DomWidgetRenderer = (host, props) => {
    const el = document.createElement("span");
    el.textContent = `${props.widget.title}=${String(props.value)}|${props.status?.state ?? "-"}`;
    host.appendChild(el);
    calls.push(`mount:${props.widget.id}`);
    let title = props.widget.title;
    return {
      update: (value, status) => {
        el.textContent = `${title}=${String(value)}|${status?.state ?? "-"}`;
        calls.push(`update:${props.widget.id}`);
      },
      ...(withPatch && {
        patch: (w: Widget) => {
          title = w.title;
          calls.push(`patch:${w.id}`);
          el.textContent = `${title}=${el.textContent?.split("=")[1] ?? ""}`;
        },
      }),
      dispose: () => calls.push(`dispose:${props.widget.id}`),
    };
  };
  const note: DomWidgetRenderer = (host, props) => {
    const ta = document.createElement("textarea");
    ta.dataset.note = props.widget.id;
    host.appendChild(ta);
    calls.push(`mount:${props.widget.id}`);
    return {
      update: () => calls.push(`update:${props.widget.id}`),
      patch: (w) => calls.push(`patch:${w.id}`),
      dispose: () => calls.push(`dispose:${props.widget.id}`),
    };
  };
  const registry = new RendererRegistry<DomWidgetRenderer>()
    .register("MetricCard", plain)
    .register("StatusBadge", plain)
    .register("NoteInput", note);
  return { registry, calls };
};

const note = (id: string): Widget => ({
  _tag: "Widget" as const,
  id,
  kind: "NoteInput",
  title: "Note",
  props: {},
});

const v1 = (): Blueprint =>
  blueprint$({
    id: "e@1",
    title: "Board",
    projections: [HYDRATION_PROJECTION_ID],
    layout: grid({
      columns: 12,
      children: [
        cell(4, MetricCard({ id: "p99", title: "p99", binding: bind("h-p99"), unit: "ms" })),
        cell(8, note("memo")),
        stack({
          children: [StatusBadge({ id: "phase", title: "Phase", binding: bind("h-phase") })],
        }),
      ],
    }),
  });

/** v1's shape with explicit grid lines on its first two cells (Blueprint IR 2.1.0). */
const placedV = (p99: { row?: number; column?: number }, memoRowSpan?: number): Blueprint =>
  blueprint$({
    id: "e@1",
    title: "Board",
    projections: [HYDRATION_PROJECTION_ID],
    layout: grid({
      columns: 12,
      children: [
        cell(4, MetricCard({ id: "p99", title: "p99", binding: bind("h-p99"), unit: "ms" }), p99),
        cell(8, note("memo"), memoRowSpan !== undefined ? { rowSpan: memoRowSpan } : {}),
        stack({
          children: [StatusBadge({ id: "phase", title: "Phase", binding: bind("h-phase") })],
        }),
      ],
    }),
  });

/** p99 at the root; the memo note inside a placed stack that may carry a title; the root may too. */
const sectioned = (stackTitle?: string, rootTitle?: string): Blueprint =>
  blueprint$({
    id: "e@1",
    title: "Board",
    projections: [HYDRATION_PROJECTION_ID],
    layout: grid({
      columns: 12,
      ...(rootTitle !== undefined && { title: rootTitle }),
      children: [
        cell(4, MetricCard({ id: "p99", title: "p99", binding: bind("h-p99"), unit: "ms" })),
        cell(
          8,
          stack({
            ...(stackTitle !== undefined && { title: stackTitle }),
            children: [note("memo")],
          }),
          { row: 1, column: 5 }
        ),
      ],
    }),
  });

/**
 * Counts `subscribeSelector` calls and the subscriptions still live, by wrapping the runtime's
 * own method — the adapter's only subscription path. `throwFor` makes a subscribe to that
 * projection id throw AFTER the renderer ran, which is the one mid-pass throw a renderer cannot
 * cause and `renderInto` does not catch.
 */
const countSubscriptions = (runtime: InMemoryProjectionRuntime, throwFor?: string) => {
  const counts = { subscribes: 0, live: 0 };
  const orig = runtime.subscribeSelector.bind(runtime);
  runtime.subscribeSelector = ((...args: Parameters<typeof orig>) => {
    if (args[0] === throwFor) throw new Error(`subscribe refused: ${throwFor}`);
    counts.subscribes++;
    counts.live++;
    const off = orig(...args);
    return () => {
      counts.live--;
      off();
    };
  }) as typeof runtime.subscribeSelector;
  return counts;
};

const setup = (
  bp: Blueprint = v1(),
  reg = recording(),
  wrap?: (runtime: InMemoryProjectionRuntime) => void
) => {
  const runtime = new InMemoryProjectionRuntime();
  wrap?.(runtime);
  const store = new HydrationStore(runtime, { experienceId: "e" });
  store.setValue("h-p99", 412, { state: "ready" });
  store.setValue("h-phase", "triage", { state: "ready" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = renderBlueprintDom(host, bp, {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: reg.registry,
  });
  return { runtime, store, host, handle, calls: reg.calls, registry: reg.registry };
};

/** Tag + data-* + inline style + children, recursively — the "DOM shape" two mounts must share. */
const shape = (el: Element): unknown => ({
  tag: el.tagName,
  data: { ...(el as HTMLElement).dataset },
  style: (el as HTMLElement).style.cssText,
  text: el.children.length === 0 ? el.textContent : undefined,
  children: [...el.children].map(shape),
});

const freshShape = (
  bp: Blueprint,
  store: HydrationStore,
  runtime: InMemoryProjectionRuntime,
  registry: RendererRegistry<DomWidgetRenderer> = recording().registry
) => {
  const host = document.createElement("div");
  const h = renderBlueprintDom(host, bp, {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry,
  });
  const s = shape(h.element);
  h.dispose();
  return s;
};

describe("renderBlueprintDom.update — keyed recompose", () => {
  it("an identical blueprint makes zero DOM mutations and reports nothing", () => {
    const { host, handle, calls } = setup();
    const before = [...host.querySelectorAll("*")];
    calls.length = 0;
    // Literally zero, not merely invisible: an attribute rewritten to the value it already holds
    // is a real MutationRecord, and `styleContainer`/`applyPlacement`/the root chrome run over every
    // node on every pass.
    const observer = new MutationObserver(() => {});
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const r = handle.update(v1());
    const records = observer.takeRecords();
    observer.disconnect();
    const after = [...host.querySelectorAll("*")];
    expect(records).toEqual([]);
    expect(r).toEqual({
      identity: expect.objectContaining({ ok: true, added: [], findings: [] }),
      remounted: [],
      rebound: [],
      findings: [],
    });
    expect(after.length).toBe(before.length);
    expect(after.every((n, i) => n === before[i])).toBe(true); // same nodes, same order (identity, not deep-equal)
    expect(calls).toEqual([]);
    handle.dispose();
  });

  it("an identical blueprint with an unregistered projection makes zero DOM mutations", () => {
    // v1() only declares HYDRATION_PROJECTION_ID, which `setup()`'s store always resolves, so the
    // root-chrome placeholder block never runs over a non-empty `unregistered` list in the row
    // above. A declared-but-never-registered projection is the case that block exists for.
    const bp = v1();
    (bp as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "ghost"];
    const { host, handle, calls } = setup(bp);
    calls.length = 0;
    const observer = new MutationObserver(() => {});
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const next = v1();
    (next as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "ghost"];
    const r = handle.update(next);
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.remounted).toEqual([]);
    expect(calls).toEqual([]);
    handle.dispose();
  });

  it("a changed unregistered-projection set replaces exactly the placeholders, in the new order, with shape parity", () => {
    const bp = v1();
    (bp as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "ghost-a", "ghost-b"];
    const { host, handle, store, runtime } = setup(bp);
    const next = v1();
    (next as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "ghost-c"];
    handle.update(next);
    expect(
      [...host.querySelectorAll("[data-placeholder='projection']")].map((e) => e.textContent)
    ).toEqual(['[Projection "ghost-c" is not registered]']);
    // Placeholders still sit between the title and the root container, exactly where a fresh
    // mount puts them.
    expect([...handle.element.children].map((e) => (e as HTMLElement).dataset.placeholder)).toEqual(
      [undefined, "projection", undefined]
    );
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("a kept widget whose node changed is patched in place: same host, same element, patch called, no remount", () => {
    const { host, handle, calls, store, runtime } = setup();
    const p99El = host.querySelector("[data-widget-id='p99'] span");
    calls.length = 0;
    const next = v1();
    const g = next.layout as { children: Array<{ node: { title?: string } }> };
    g.children[0]!.node.title = "p99 (ms)";
    const r = handle.update(next);
    expect(calls).toEqual(["patch:p99"]);
    expect(host.querySelector("[data-widget-id='p99'] span")).toBe(p99El);
    expect(p99El?.textContent).toBe("p99 (ms)=412|ready");
    expect(r.remounted).toEqual([]);
    // The node-identity checks above are strictly stronger for `p99` alone; this covers the
    // whole tree, including the siblings the identity checks never look at.
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("added at position, dropped disposed and removed, identity is loom's report", () => {
    const { host, handle, calls, store, runtime } = setup();
    store.setValue("h-new", 7, { state: "ready" });
    calls.length = 0;
    const next = blueprint$({
      id: "e@2",
      title: "Board",
      projections: [HYDRATION_PROJECTION_ID],
      layout: grid({
        columns: 12,
        children: [
          cell(12, MetricCard({ id: "new", title: "New", binding: bind("h-new") })),
          cell(4, MetricCard({ id: "p99", title: "p99", binding: bind("h-p99"), unit: "ms" })),
          cell(8, note("memo")),
        ],
      }),
    });
    const r = handle.update(next);
    expect(r.identity.added).toEqual(["new"]);
    expect(r.identity.findings.map((f) => f.nodeId)).toEqual(["phase"]);
    // `phase` was disposed, but it is ABSENT from `next` — it was dropped, not remounted.
    expect(r.remounted).toEqual([]);
    expect(calls).toEqual(["mount:new", "dispose:phase"]);
    const ids = [...host.querySelectorAll("[data-layout='grid'] > [data-widget-id]")].map(
      (e) => (e as HTMLElement).dataset.widgetId
    );
    expect(ids).toEqual(["new", "p99", "memo"]);
    expect(host.querySelector("[data-layout='stack']")).toBeNull();
    expect(host.querySelector("[data-blueprint-id='e@2']")).not.toBeNull();
    expect(host.querySelector("[data-widget-id='new']")?.textContent).toBe("New=7|ready");
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
    // The entry tree `dispose` walks is the one `update` left: each live widget once, and the
    // widget the update already dropped is NOT disposed a second time.
    expect(calls.filter((c) => c.startsWith("dispose:")).sort()).toEqual([
      "dispose:memo",
      "dispose:new",
      "dispose:p99",
      "dispose:phase",
    ]);
  });

  it("reordering never moves the focused subtree: the textarea keeps focus, value and selection while its siblings move around it", () => {
    const { host, handle, store, runtime } = setup();
    const ta = host.querySelector("textarea[data-note='memo']") as HTMLTextAreaElement;
    ta.focus();
    ta.value = "half-typed note";
    ta.setSelectionRange(4, 4);
    expect(document.activeElement).toBe(ta);
    const next = v1();
    const g = next.layout as { children: unknown[] };
    // memo first, then the stack, then p99
    g.children = [g.children[1], g.children[2], g.children[0]];
    handle.update(next);
    const order = [...(host.querySelector("[data-layout='grid']") as HTMLElement).children].map(
      (e) => (e as HTMLElement).dataset.widgetId ?? (e as HTMLElement).dataset.layout
    );
    expect(order).toEqual(["memo", "stack", "p99"]);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("half-typed note");
    expect(ta.selectionStart).toBe(4);
    expect(host.querySelector("textarea[data-note='memo']")).toBe(ta);
    // The node-identity checks above only look at `memo`'s textarea; this covers the whole tree
    // (`.value` is a live-DOM property, not reflected in `textContent`, so it does not upset shape
    // parity even though the focused textarea was never remounted).
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("a span change lands on the kept host; dropping to 1 clears it", () => {
    const { host, handle, store, runtime } = setup();
    const p99Host = host.querySelector("[data-widget-id='p99']") as HTMLElement;
    expect(p99Host.style.gridColumn).toBe("span 4");
    const next = v1();
    const g = next.layout as { children: Array<{ span?: number }> };
    g.children[0]!.span = 6;
    g.children[1]!.span = 1;
    handle.update(next);
    expect(p99Host.style.gridColumn).toBe("span 6");
    expect((host.querySelector("[data-widget-id='memo']") as HTMLElement).style.gridColumn).toBe(
      ""
    );
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("a kind change remounts exactly that widget and reports it", () => {
    const { host, handle, calls, store, runtime } = setup();
    const memoEl = host.querySelector("[data-widget-id='memo'] textarea");
    calls.length = 0;
    const next = v1();
    const g = next.layout as { children: Array<{ node: { kind: string } }> };
    g.children[1]!.node.kind = "StatusBadge";
    const r = handle.update(next);
    expect(r.remounted).toEqual(["memo"]);
    expect(calls).toEqual(["dispose:memo", "mount:memo"]);
    expect(host.querySelector("[data-widget-id='memo'] textarea")).toBeNull();
    expect(memoEl?.isConnected).toBe(false);
    expect((host.querySelector("[data-widget-id='memo']") as HTMLElement).dataset.widgetKind).toBe(
      "StatusBadge"
    );
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("a kept id whose kind changes to one no renderer is registered for is remounted onto the missing placeholder and reported", () => {
    const { host, handle, calls, store, runtime } = setup();
    calls.length = 0;
    const next = v1();
    const g = next.layout as { children: Array<{ node: { kind: string } }> };
    g.children[1]!.node.kind = "Nope";
    const r = handle.update(next);
    expect(r.remounted).toEqual(["memo"]);
    expect(r.findings).toEqual([
      { code: "mount-failed", nodeId: "memo", message: 'no renderer for "Nope"' },
    ]);
    expect(calls).toEqual(["dispose:memo"]); // disposed, and nothing mounted in its place
    const memoHost = host.querySelector("[data-widget-id='memo']") as HTMLElement;
    expect(memoHost.textContent).toBe("[No renderer for Nope]");
    expect(memoHost.dataset.widgetKind).toBe("Nope");
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("a renderer without patch is remounted on a node change and reported", () => {
    const reg = recording(false);
    const { handle, calls, store, runtime } = setup(v1(), reg);
    calls.length = 0;
    const next = v1();
    (next.layout as { children: Array<{ node: { title?: string } }> }).children[0]!.node.title =
      "x";
    const r = handle.update(next);
    expect(r.remounted).toEqual(["p99"]);
    expect(calls).toEqual(["dispose:p99", "mount:p99"]);
    // Compared against a fresh render built with THIS row's registry (no `patch`), not the
    // default `recording()` — a fresh mount never calls `patch` either way, but a distinct
    // registry instance keeps this row's own `calls` ledger (already asserted above) untouched.
    expect(shape(handle.element)).toEqual(
      freshShape(next, store, runtime, recording(false).registry)
    );
    handle.dispose();
  });

  it("a binding change re-subscribes and pushes the first slice synchronously; unchanged bindings keep their subscription", async () => {
    const { host, handle, calls, store, runtime } = setup();
    store.setValue("h-alt", 99, { state: "ready" });
    calls.length = 0;
    const next = v1();
    (next.layout as { children: Array<{ node: { binding?: DataBinding } }> })
      .children[0]!.node.binding = bind("h-alt");
    const r = handle.update(next);
    expect(r.rebound).toEqual(["p99"]);
    expect(calls).toEqual(["patch:p99", "update:p99"]);
    expect(host.querySelector("[data-widget-id='p99'] span")?.textContent).toBe("p99=99|ready");
    // Checked here, before the further `store.setValue` calls below change values a fresh mount
    // would also observe — the point of this assertion is the rebind, not the later pushes.
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    calls.length = 0;
    store.setValue("h-p99", 1, { state: "ready" }); // the OLD handle: nobody listens any more
    store.setValue("h-alt", 100, { state: "ready" });
    store.setValue("h-phase", "done", { state: "ready" }); // unchanged binding still live
    await Promise.resolve();
    expect(calls.sort()).toEqual(["update:p99", "update:phase"]);
    handle.dispose();
  });

  it("container styles are patched in place; a container TYPE change remounts that container's widgets", () => {
    const { host, handle, calls, store, runtime } = setup();
    const gridEl = host.querySelector("[data-layout='grid']") as HTMLElement;
    calls.length = 0;
    const a = v1();
    (a.layout as { gap?: number }).gap = 8;
    handle.update(a);
    expect(host.querySelector("[data-layout='grid']")).toBe(gridEl);
    expect(gridEl.style.gap).toBe("8px");
    expect(calls).toEqual([]);
    const b = v1();
    const g = b.layout as { children: unknown[] };
    g.children[2] = flex({
      direction: "row",
      children: [StatusBadge({ id: "phase", title: "Phase", binding: bind("h-phase") })],
    });
    const r = handle.update(b);
    expect(r.remounted).toEqual(["phase"]);
    expect(calls).toEqual(["dispose:phase", "mount:phase"]);
    expect(host.querySelector("[data-layout='stack']")).toBeNull();
    expect((host.querySelector("[data-layout='flex']") as HTMLElement).style.flexDirection).toBe(
      "row"
    );
    expect(shape(handle.element)).toEqual(freshShape(b, store, runtime));
    handle.dispose();
  });

  it("the ROOT container's type change is patched in place: the root element, and every kept widget's element, survive", () => {
    const { host, handle, calls, store, runtime } = setup();
    const rootEl = host.querySelector("[data-layout='grid']") as HTMLElement;
    const p99Host = host.querySelector("[data-widget-id='p99']") as HTMLElement;
    const ta = host.querySelector("textarea[data-note='memo']") as HTMLTextAreaElement;
    calls.length = 0;
    // The root has no parent to be keyed by position within, so — unlike every other container —
    // a type change re-styles it rather than sweeping it away.
    const next = blueprint$({
      id: "e@1",
      title: "Board",
      projections: [HYDRATION_PROJECTION_ID],
      layout: stack({
        children: [
          MetricCard({ id: "p99", title: "p99", binding: bind("h-p99"), unit: "ms" }),
          note("memo"),
        ],
      }),
    });
    const r = handle.update(next);
    expect(host.querySelector("[data-layout='stack']")).toBe(rootEl);
    expect(host.querySelector("[data-layout='grid']")).toBeNull();
    expect(host.querySelector("[data-widget-id='p99']")).toBe(p99Host);
    expect(host.querySelector("textarea[data-note='memo']")).toBe(ta);
    expect(p99Host.style.gridColumn).toBe(""); // no longer under a grid
    expect(r.remounted).toEqual([]); // `phase` went with the dropped stack; nothing was re-created
    expect(r.identity.findings.map((f) => f.nodeId)).toEqual(["phase"]);
    expect(calls).toEqual(["dispose:phase"]);
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("dropping the FIRST of two sibling containers: the survivor's widgets are remounted, the dropped one's id is only in identity", () => {
    const twoStacks = (): Blueprint =>
      blueprint$({
        id: "e@1",
        title: "Board",
        projections: [HYDRATION_PROJECTION_ID],
        layout: grid({
          columns: 12,
          children: [
            stack({ children: [MetricCard({ id: "a", title: "A", binding: bind("h-a") })] }),
            stack({ children: [MetricCard({ id: "b", title: "B", binding: bind("h-b") })] }),
          ],
        }),
      });
    const { host, handle, calls, store, runtime } = setup(twoStacks());
    const bHostBefore = host.querySelector("[data-widget-id='b']");
    calls.length = 0;
    // Containers are keyed by ORDINAL, so dropping the first shifts the second onto the first's
    // entry: `b` really is destroyed and re-created, and the report has to say so.
    const next = blueprint$({
      id: "e@1",
      title: "Board",
      projections: [HYDRATION_PROJECTION_ID],
      layout: grid({
        columns: 12,
        children: [
          stack({ children: [MetricCard({ id: "b", title: "B", binding: bind("h-b") })] }),
        ],
      }),
    });
    const r = handle.update(next);
    expect(r.remounted).toEqual(["b"]);
    expect(r.remounted).not.toContain("a");
    expect(r.identity.findings.map((f) => f.nodeId)).toEqual(["a"]);
    expect(calls).toEqual(["mount:b", "dispose:a", "dispose:b"]);
    expect(host.querySelectorAll("[data-widget-id='b']")).toHaveLength(1);
    expect(host.querySelector("[data-widget-id='b']")).not.toBe(bHostBefore);
    expect(host.querySelector("[data-widget-id='a']")).toBeNull();
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("a widget moved out of a nested container into the root is remounted, and the report says so", () => {
    const { host, handle, calls, store, runtime } = setup();
    store.setValue("h-extra", 3, { state: "ready" });
    const phaseHostBefore = host.querySelector("[data-widget-id='phase']") as HTMLElement;
    calls.length = 0;
    // Widgets are keyed PER CONTAINER: `phase` leaving the stack for the root grid is a destroy
    // and a create, not a move. `remounted` is what tells the caller its DOM state is gone.
    const next = blueprint$({
      id: "e@1",
      title: "Board",
      projections: [HYDRATION_PROJECTION_ID],
      layout: grid({
        columns: 12,
        children: [
          cell(4, MetricCard({ id: "p99", title: "p99", binding: bind("h-p99"), unit: "ms" })),
          cell(8, note("memo")),
          cell(12, StatusBadge({ id: "phase", title: "Phase", binding: bind("h-phase") })),
          stack({
            children: [MetricCard({ id: "extra", title: "Extra", binding: bind("h-extra") })],
          }),
        ],
      }),
    });
    const r = handle.update(next);
    expect(r.remounted).toEqual(["phase"]);
    expect(r.identity.added).toEqual(["extra"]);
    expect(r.identity.findings).toEqual([]);
    expect(calls).toEqual(["mount:phase", "mount:extra", "dispose:phase"]);
    const phaseHostAfter = host.querySelector("[data-widget-id='phase']") as HTMLElement;
    expect(phaseHostAfter).not.toBe(phaseHostBefore);
    expect(phaseHostBefore.isConnected).toBe(false);
    expect(phaseHostAfter.parentElement).toBe(host.querySelector("[data-layout='grid']"));
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("a renderer that throws on patch leaves that widget on the error placeholder, reports it, and the rest updates", () => {
    const calls: string[] = [];
    const throwing: DomWidgetRenderer = (host, props) => {
      const el = document.createElement("i");
      host.appendChild(el);
      return {
        update: () => {},
        patch: () => {
          throw new Error("cannot relabel");
        },
        dispose: () => calls.push(`dispose:${props.widget.id}`),
      };
    };
    const reg = recording();
    reg.registry.register("MetricCard", throwing);
    const { host, handle } = setup(v1(), reg);
    const next = v1();
    const g = next.layout as { children: Array<{ node: { title?: string } }> };
    g.children[0]!.node.title = "renamed";
    g.children[2] = stack({
      children: [StatusBadge({ id: "phase", title: "Phase 2", binding: bind("h-phase") })],
    }) as never;
    const r = handle.update(next);
    expect(r.findings).toEqual([
      { code: "patch-failed", nodeId: "p99", message: "cannot relabel" },
    ]);
    // A degraded widget is NOT a remount: it holds no handle at all.
    expect(r.remounted).toEqual([]);
    expect(
      host.querySelector("[data-widget-id='p99'] [data-placeholder='error']")?.textContent
    ).toBe("[Renderer error for MetricCard: cannot relabel]");
    expect(reg.calls).toContain("patch:phase");
    // No shape parity here: `next` still declares `p99` as a plain MetricCard, so a fresh mount
    // of `next` would render it normally — the live tree's error placeholder (reached only
    // because `patch` throws, which a fresh mount never calls) has no fresh-render equivalent.
    // The failed widget was TORN DOWN, not just hidden: its handle was disposed once…
    expect(calls).toEqual(["dispose:p99"]);
    handle.dispose();
    expect(calls).toEqual(["dispose:p99"]); // …and the teardown does not dispose it twice.
  });

  it("a renderer that throws from update is torn down: disposed once, unsubscribed, and never disposed twice", () => {
    // No shape parity in this row: it never calls `handle.update(next)` at all — it drives the
    // existing binding subscription via `store.setValue`, and the degraded error placeholder
    // this leaves `p99` on has no fresh-render equivalent (a fresh mount never calls `update`
    // enough times to throw).
    const seen: string[] = [];
    let n = 0;
    const brittle: DomWidgetRenderer = (host, props) => {
      host.appendChild(document.createElement("i"));
      return {
        update: () => {
          n += 1;
          seen.push(`update:${props.widget.id}`);
          if (n >= 2) throw new Error("boom");
        },
        dispose: () => seen.push(`dispose:${props.widget.id}`),
      };
    };
    const reg = recording();
    reg.registry.register("MetricCard", brittle);
    const { host, handle, store } = setup(v1(), reg);
    store.setValue("h-p99", 1, { state: "ready" });
    store.setValue("h-p99", 2, { state: "ready" }); // the second update throws
    expect(seen).toEqual(["update:p99", "update:p99", "dispose:p99"]);
    expect(
      host.querySelector("[data-widget-id='p99'] [data-placeholder='error']")?.textContent
    ).toBe("[Renderer error for MetricCard: boom]");
    store.setValue("h-p99", 3, { state: "ready" }); // the subscription is gone with the handle
    expect(seen).toEqual(["update:p99", "update:p99", "dispose:p99"]);
    handle.dispose();
    expect(seen.filter((c) => c === "dispose:p99")).toHaveLength(1);
  });

  it("a widget added with a kind no renderer is registered for lands in findings as mount-failed", () => {
    const { host, handle, store, runtime } = setup();
    const next = v1();
    const g = next.layout as { children: unknown[] };
    g.children.push(cell(4, { _tag: "Widget" as const, id: "odd", kind: "Nope", props: {} }));
    const r = handle.update(next);
    expect(r.findings).toEqual([
      { code: "mount-failed", nodeId: "odd", message: 'no renderer for "Nope"' },
    ]);
    expect(host.querySelector("[data-widget-id='odd']")?.textContent).toBe(
      "[No renderer for Nope]"
    );
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("update never throws: a Blueprint the adapter cannot even walk comes back as a finding, live tree untouched", () => {
    // No shape parity: `next` is unwalkable (`children: null`), so there is no well-defined fresh
    // render to build one from — the point of this row is that the LIVE tree is left untouched,
    // which the before/after node-identity check below proves directly.
    const { host, handle } = setup();
    const before = [...host.querySelectorAll("*")];
    const next = v1();
    (next.layout as { children: unknown }).children = null;
    let r!: RecomposeReport;
    expect(() => {
      r = handle.update(next);
    }).not.toThrow();
    expect(r.findings.map((f) => f.code)).toEqual(["patch-failed"]);
    expect(r.findings[0]?.nodeId).toBe("");
    expect(r.identity.compared).toBe(0); // loom's own tell that nothing was compared
    expect(r.remounted).toEqual([]);
    const after = [...host.querySelectorAll("*")];
    expect(after.length).toBe(before.length);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    handle.dispose();
  });

  it("title, blueprint id and projection placeholders are patched; update after dispose is a reported no-op", () => {
    const { host, handle, calls, store, runtime } = setup();
    const next = v1();
    (next as { title: string }).title = "Board v2";
    (next as { id: string }).id = "e@2";
    (next as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "ghost"];
    handle.update(next);
    expect(host.querySelector("h1")?.textContent).toBe("Board v2");
    expect(handle.element.dataset.blueprintId).toBe("e@2");
    expect(host.querySelector("[data-placeholder='projection']")?.textContent).toBe(
      '[Projection "ghost" is not registered]'
    );
    // Rebuilt placeholders sit between the title and the root container, exactly where a fresh
    // mount puts them.
    expect([...handle.element.children].map((e) => (e as HTMLElement).dataset.placeholder)).toEqual(
      [undefined, "projection", undefined]
    );
    expect(handle.element.children[0]?.tagName).toBe("H1");
    expect((handle.element.children[2] as HTMLElement).dataset.layout).toBe("grid");
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
    calls.length = 0;
    const r = handle.update(v1());
    expect(r.findings).toEqual([{ code: "patch-failed", nodeId: "", message: "disposed" }]);
    expect(r.remounted).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("IR 2.1.0: an identical PLACED blueprint makes zero DOM mutations", () => {
    const { host, handle, calls } = setup(placedV({ row: 2, column: 1 }, 2));
    calls.length = 0;
    const observer = new MutationObserver(() => {});
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    handle.update(placedV({ row: 2, column: 1 }, 2));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
    expect(calls).toEqual([]);
    handle.dispose();
  });
  it("IR 2.1.0: a placement change is a style patch on the kept host — no remount, shape parity", () => {
    const { host, handle, calls, store, runtime } = setup(placedV({ row: 1, column: 1 }));
    const p99Host = host.querySelector("[data-widget-id='p99']") as HTMLElement;
    const memoHost = host.querySelector("[data-widget-id='memo']") as HTMLElement;
    expect([p99Host.style.gridColumn, p99Host.style.gridRow]).toEqual(["1 / span 4", "1 / span 1"]);
    calls.length = 0;
    const next = placedV({ row: 3, column: 9 }, 2);
    const r = handle.update(next);
    expect(host.querySelector("[data-widget-id='p99']")).toBe(p99Host);
    expect([p99Host.style.gridColumn, p99Host.style.gridRow]).toEqual(["9 / span 4", "3 / span 1"]);
    expect([memoHost.style.gridColumn, memoHost.style.gridRow]).toEqual(["span 8", "span 2"]);
    expect(r.remounted).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(calls).toEqual([]);
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    // Back to flow placement: the grid lines placement wrote are cleared; the span alone remains.
    const flow = placedV({});
    handle.update(flow);
    expect([p99Host.style.gridColumn, p99Host.style.gridRow]).toEqual(["span 4", ""]);
    expect(memoHost.style.gridRow).toBe("");
    expect(calls).toEqual([]);
    expect(shape(handle.element)).toEqual(freshShape(flow, store, runtime));
    handle.dispose();
  });
  it("IR 2.1.0: a placed widget whose container stops being a grid loses its grid lines", () => {
    const { host, handle } = setup(placedV({ row: 2, column: 5 }));
    const p99Host = host.querySelector("[data-widget-id='p99']") as HTMLElement;
    handle.update(
      blueprint$({
        id: "e@1",
        title: "Board",
        projections: [HYDRATION_PROJECTION_ID],
        layout: stack({
          children: [
            MetricCard({ id: "p99", title: "p99", binding: bind("h-p99"), unit: "ms" }),
            note("memo"),
          ],
        }),
      })
    );
    expect(host.querySelector("[data-widget-id='p99']")).toBe(p99Host);
    expect([p99Host.style.gridColumn, p99Host.style.gridRow]).toEqual(["", ""]);
    handle.dispose();
  });
  it("IR 2.1.0: an identical TITLED blueprint makes zero DOM mutations", () => {
    const { host, handle, calls } = setup(sectioned("Notes", "Board sections"));
    calls.length = 0;
    const observer = new MutationObserver(() => {});
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    handle.update(sectioned("Notes", "Board sections"));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
    expect(calls).toEqual([]);
    handle.dispose();
  });

  it("IR 2.1.0: a title's text change patches the heading and the label in place", () => {
    const { host, handle, calls, store, runtime } = setup(sectioned("Notes"));
    const section = host.querySelector("section[aria-label='Notes']") as HTMLElement;
    const h2 = section.querySelector("h2") as HTMLElement;
    calls.length = 0;
    const next = sectioned("Shift notes");
    handle.update(next);
    expect(host.querySelector("section")).toBe(section);
    expect(section.querySelector("h2")).toBe(h2);
    expect(h2.textContent).toBe("Shift notes");
    expect(section.getAttribute("aria-label")).toBe("Shift notes");
    expect(calls).toEqual([]);
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });

  it("IR 2.1.0: adding then removing a title wraps and unwraps the SAME layout element — widgets, focus and selection kept, grid lines on whatever sits in the grid", () => {
    const { host, handle, calls, store, runtime } = setup(sectioned());
    const stackEl = host.querySelector("[data-layout='stack']") as HTMLElement;
    const gridEl = host.querySelector("[data-layout='grid']") as HTMLElement;
    const ta = host.querySelector("textarea[data-note='memo']") as HTMLTextAreaElement;
    expect(stackEl.style.gridColumn).toBe("5 / span 8");
    ta.focus();
    ta.value = "half-typed";
    ta.setSelectionRange(4, 4);
    calls.length = 0;

    const titled = sectioned("Notes");
    const r = handle.update(titled);
    const section = host.querySelector("section[aria-label='Notes']") as HTMLElement;
    expect(section.parentElement).toBe(gridEl);
    expect(section.children[1]).toBe(stackEl);
    expect(host.querySelector("textarea[data-note='memo']")).toBe(ta);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("half-typed");
    expect(ta.selectionStart).toBe(4);
    expect([section.style.gridColumn, section.style.gridRow]).toEqual(["5 / span 8", "1 / span 1"]);
    expect([stackEl.style.gridColumn, stackEl.style.gridRow]).toEqual(["", ""]);
    expect(r.remounted).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(calls).toEqual([]);
    expect(shape(handle.element)).toEqual(freshShape(titled, store, runtime));

    const untitled = sectioned();
    handle.update(untitled);
    expect(host.querySelector("section")).toBeNull();
    expect(stackEl.parentElement).toBe(gridEl);
    expect([stackEl.style.gridColumn, stackEl.style.gridRow]).toEqual(["5 / span 8", "1 / span 1"]);
    expect(document.activeElement).toBe(ta);
    expect(calls).toEqual([]);
    expect(shape(handle.element)).toEqual(freshShape(untitled, store, runtime));
    handle.dispose();
  });

  it("IR 2.1.0: the ROOT gains a title in place; projection placeholders stay before it", () => {
    const bp = sectioned();
    (bp as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "ghost"];
    const { host, handle, store, runtime } = setup(bp);
    const gridEl = host.querySelector("[data-layout='grid']") as HTMLElement;
    const next = sectioned(undefined, "Board sections");
    (next as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "ghost", "ghost-2"];
    handle.update(next);
    const top = [...handle.element.children] as HTMLElement[];
    expect(top.map((c) => c.tagName)).toEqual(["H1", "DIV", "DIV", "SECTION"]);
    expect(top.slice(1, 3).map((c) => c.dataset.projectionId)).toEqual(["ghost", "ghost-2"]);
    expect(top[3]?.children[1]).toBe(gridEl);
    expect(shape(handle.element)).toEqual(freshShape(next, store, runtime));
    handle.dispose();
  });
});

describe("renderBlueprintDom.update — a pass that cannot complete leaves nothing behind", () => {
  it("a nested undefined child after a NEW sibling: a finding, no throw, live DOM untouched, nothing mounted or leaked", () => {
    // loom's `blueprintNodeIds` skips malformed nodes without reporting them, so the identity walk passes;
    // the reconcile is what would have hit it — after the new sibling had already mounted.
    let counts!: ReturnType<typeof countSubscriptions>;
    const { host, handle, calls } = setup(v1(), recording(), (rt) => {
      counts = countSubscriptions(rt);
    });
    const before = [...host.querySelectorAll("*")];
    const liveBefore = counts.live;
    calls.length = 0;
    const next = v1();
    const inner = (next.layout as { children: Array<{ node: { children: unknown[] } }> })
      .children[2]!.node;
    inner.children.push(
      MetricCard({ id: "fresh", title: "Fresh", binding: bind("h-p99"), unit: "ms" }),
      undefined
    );
    let r!: RecomposeReport;
    expect(() => {
      r = handle.update(next);
    }).not.toThrow();
    expect(r.findings).toEqual([
      {
        code: "patch-failed",
        nodeId: "",
        message: "malformed node at layout.children[2].children[2]",
      },
    ]);
    // Not loom's report over `next`: its walk skips the malformed node without reporting it.
    // A rejected tree was not compared, and the report says so.
    expect(r.identity).toEqual({ ok: true, findings: [], added: [], compared: 0 });
    expect(r.remounted).toEqual([]);
    expect(r.rebound).toEqual([]);
    const after = [...host.querySelectorAll("*")];
    expect(after.length).toBe(before.length);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    expect(host.querySelector("[data-widget-id='fresh']")).toBeNull();
    expect(calls).toEqual([]); // rejected before anything mounted
    expect(counts.live).toBe(liveBefore);
    handle.dispose();
    expect(counts.live).toBe(0);
  });

  it("isWidgetNode is total: undefined, null and primitives are simply not widgets", () => {
    for (const n of [undefined, null, 0, "Widget", {}, { type: "stack", children: [] }])
      expect(isWidgetNode(n as never)).toBe(false);
    expect(isWidgetNode(note("x"))).toBe(true);
  });

  it("a throw the validation cannot foresee (a refused subscribe) disposes and removes everything the pass mounted", () => {
    let counts!: ReturnType<typeof countSubscriptions>;
    const { host, handle, calls } = setup(v1(), recording(), (rt) => {
      counts = countSubscriptions(rt, "boom");
    });
    const before = [...host.querySelectorAll("*")];
    const liveBefore = counts.live;
    calls.length = 0;
    const next = v1();
    const g = next.layout as { children: unknown[] };
    g.children.push(
      cell(4, MetricCard({ id: "fresh", title: "Fresh", binding: bind("h-p99"), unit: "ms" })),
      cell(
        4,
        MetricCard({
          id: "doomed",
          title: "Doomed",
          binding: { projectionId: "boom", path: "x" },
          unit: "ms",
        })
      )
    );
    (next as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "boom"];
    let r!: RecomposeReport;
    expect(() => {
      r = handle.update(next);
    }).not.toThrow();
    expect(r.findings).toContainEqual({
      code: "patch-failed",
      nodeId: "",
      message: "subscribe refused: boom",
    });
    // Both widgets the pass mounted were disposed and their hosts removed; `fresh`'s
    // subscription is gone with it.
    expect(calls.filter((c) => c.startsWith("mount:")).sort()).toEqual([
      "mount:doomed",
      "mount:fresh",
    ]);
    expect(calls.filter((c) => c.startsWith("dispose:")).sort()).toEqual([
      "dispose:doomed",
      "dispose:fresh",
    ]);
    expect(host.querySelector("[data-widget-id='fresh']")).toBeNull();
    expect(host.querySelector("[data-widget-id='doomed']")).toBeNull();
    expect(counts.live).toBe(liveBefore);
    const after = [...host.querySelectorAll("*")];
    expect(after.length).toBe(before.length);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    calls.length = 0;
    handle.dispose();
    expect(counts.live).toBe(0);
    expect(calls.filter((c) => c === "dispose:fresh")).toEqual([]); // never disposed twice
  });

  it("a mount a NESTED container already committed is undone too: the entry tree still mirrors the DOM", () => {
    let counts!: ReturnType<typeof countSubscriptions>;
    const { host, handle, calls, store, runtime } = setup(v1(), recording(), (rt) => {
      counts = countSubscriptions(rt, "boom");
    });
    const liveBefore = counts.live;
    const next = v1();
    const g = next.layout as { children: Array<{ node: { children?: unknown[] } }> };
    // The stack (3rd child) reconciles and COMMITS its new child before the root reaches `doomed`.
    g.children[2]!.node.children!.push(
      MetricCard({ id: "inner", title: "Inner", binding: bind("h-p99"), unit: "ms" })
    );
    (g.children as unknown[]).push(
      cell(
        4,
        MetricCard({ id: "doomed", title: "D", binding: { projectionId: "boom", path: "x" } })
      )
    );
    (next as { projections: string[] }).projections = [HYDRATION_PROJECTION_ID, "boom"];
    calls.length = 0;
    const r = handle.update(next);
    expect(r.findings.at(-1)?.message).toBe("subscribe refused: boom");
    expect(calls.filter((c) => c === "dispose:inner")).toEqual(["dispose:inner"]);
    expect(host.querySelector("[data-widget-id='inner']")).toBeNull();
    expect(counts.live).toBe(liveBefore);
    // The entry tree forgot `inner`: landing the same revision minus `doomed` MOUNTS it as the
    // new widget it is — not a "remount" of a handle-less ghost entry the failed pass left behind.
    const retry = v1();
    (
      retry.layout as { children: Array<{ node: { children?: unknown[] } }> }
    ).children[2]!.node.children!.push(
      MetricCard({ id: "inner", title: "Inner", binding: bind("h-p99"), unit: "ms" })
    );
    calls.length = 0;
    const again = handle.update(retry);
    expect(again.findings).toEqual([]);
    expect(again.remounted).toEqual([]);
    expect(again.identity.added).toEqual(["inner"]);
    expect(calls).toEqual(["mount:inner"]);
    expect(shape(handle.element)).toEqual(freshShape(retry, store, runtime));
    handle.dispose();
    expect(counts.live).toBe(0);
  });

  it("a re-entrant update (a renderer's patch calling handle.update) is refused without mutating; the outer pass completes", () => {
    const reg = recording();
    const ref: { h?: ReturnType<typeof renderBlueprintDom> } = {};
    let nested: RecomposeReport | undefined;
    const reentrant: DomWidgetRenderer = (host) => {
      host.appendChild(document.createElement("span"));
      return {
        update: () => {},
        patch: () => {
          nested = ref.h?.update(v1());
        },
        dispose: () => {},
      };
    };
    reg.registry.register("NoteInput", reentrant);
    const s = setup(v1(), reg);
    const h = s.handle;
    ref.h = h;
    const next = v1();
    (next.layout as { children: Array<{ node: { title?: string } }> }).children[1]!.node.title =
      "Note v2";
    const r = h.update(next);
    expect(nested).toEqual({
      identity: { ok: true, findings: [], added: [], compared: 0 },
      remounted: [],
      rebound: [],
      findings: [{ code: "patch-failed", nodeId: "", message: "re-entrant update" }],
    });
    expect(r.findings).toEqual([]);
    expect(shape(h.element)).toEqual(freshShape(next, s.store, s.runtime, reg.registry));
    // The guard is released: the next top-level update runs normally.
    expect(h.update(next).findings).toEqual([]);
    h.dispose();
  });

  it("update after dispose with a MALFORMED next still reports 'disposed' and touches no DOM", () => {
    const { host, handle, calls } = setup();
    const el = handle.element;
    handle.dispose();
    calls.length = 0;
    const observer = new MutationObserver(() => {});
    for (const n of [host, el])
      observer.observe(n, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    const next = v1();
    (next.layout as { children: unknown }).children = null;
    const r = handle.update(next);
    const r2 = handle.update(v1());
    const records = observer.takeRecords();
    observer.disconnect();
    expect(r.findings).toEqual([{ code: "patch-failed", nodeId: "", message: "disposed" }]);
    expect(r2.findings).toEqual([{ code: "patch-failed", nodeId: "", message: "disposed" }]);
    expect(records).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an unchanged binding keeps the SAME subscription across a prop change: no subscribe, no unsubscribe", () => {
    let counts!: ReturnType<typeof countSubscriptions>;
    const { handle } = setup(v1(), recording(), (rt) => {
      counts = countSubscriptions(rt);
    });
    const { subscribes, live } = counts;
    const next = v1();
    (next.layout as { children: Array<{ node: { title?: string } }> }).children[0]!.node.title =
      "p99 v2";
    const r = handle.update(next);
    expect(r.rebound).toEqual([]);
    expect(counts.subscribes).toBe(subscribes);
    expect(counts.live).toBe(live);
    handle.dispose();
  });

  it("a scrolled element inside a kept widget keeps its scrollTop across a patch and a reorder", () => {
    // happy-dom keeps `scrollTop` even across a DOM move (a browser drops it with the layout
    // box), so this row cannot prove that a MOVE preserves scroll — it proves the element is the
    // same one (not re-created) and that neither the patch nor the reorder resets it. The move
    // half is what the pinned-child/in-place-skip rules in `reorderChildren` are for.
    const { host, handle } = setup();
    const p99 = host.querySelector("[data-widget-id='p99']") as HTMLElement;
    p99.scrollTop = 40;
    const next = v1();
    const g = next.layout as { children: unknown[] };
    const [a, b, c] = g.children;
    g.children = [c, b, a];
    (a as { node: { title?: string } }).node.title = "p99 v2";
    handle.update(next);
    expect(host.querySelector("[data-widget-id='p99']")).toBe(p99);
    expect(p99.scrollTop).toBe(40);
    handle.dispose();
  });

  it("a dispose failure while a retyped container is swept out is reported against the WIDGET id", () => {
    const reg = recording();
    const throwing: DomWidgetRenderer = (host) => {
      host.appendChild(document.createElement("span"));
      return {
        update: () => {},
        dispose: () => {
          throw new Error("dispose boom");
        },
      };
    };
    reg.registry.register("StatusBadge", throwing);
    const { handle } = setup(v1(), reg);
    const next = v1();
    const g = next.layout as { children: Array<{ node: unknown }> };
    const stackNode = g.children[2]!.node as { children: unknown[] };
    g.children[2]!.node = flex({ children: stackNode.children as Widget[] });
    const r = handle.update(next);
    expect(r.findings).toEqual([
      { code: "mount-failed", nodeId: "phase", message: "dispose boom" },
    ]);
    try {
      handle.dispose();
    } catch {
      // the remounted `phase` throws again on the final dispose — not this row's concern
    }
  });
});
