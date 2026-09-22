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
import { type DomWidgetRenderer, renderBlueprintDom } from "./index";

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

const setup = (bp: Blueprint = v1(), reg = recording()) => {
  const runtime = new InMemoryProjectionRuntime();
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

const freshShape = (bp: Blueprint, store: HydrationStore, runtime: InMemoryProjectionRuntime) => {
  const host = document.createElement("div");
  const h = renderBlueprintDom(host, bp, {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: recording().registry,
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
    const r = handle.update(v1());
    const after = [...host.querySelectorAll("*")];
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

  it("a kept widget whose node changed is patched in place: same host, same element, patch called, no remount", () => {
    const { host, handle, calls } = setup();
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
  });

  it("reordering never moves the focused subtree: the textarea keeps focus, value and selection while its siblings move around it", () => {
    const { host, handle } = setup();
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
    handle.dispose();
  });

  it("a span change lands on the kept host; dropping to 1 clears it", () => {
    const { host, handle } = setup();
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
    handle.dispose();
  });

  it("a kind change remounts exactly that widget and reports it", () => {
    const { host, handle, calls } = setup();
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
    handle.dispose();
  });

  it("a renderer without patch is remounted on a node change and reported", () => {
    const reg = recording(false);
    const { handle, calls } = setup(v1(), reg);
    calls.length = 0;
    const next = v1();
    (next.layout as { children: Array<{ node: { title?: string } }> }).children[0]!.node.title =
      "x";
    const r = handle.update(next);
    expect(r.remounted).toEqual(["p99"]);
    expect(calls).toEqual(["dispose:p99", "mount:p99"]);
    handle.dispose();
  });

  it("a binding change re-subscribes and pushes the first slice synchronously; unchanged bindings keep their subscription", async () => {
    const { host, handle, calls, store } = setup();
    store.setValue("h-alt", 99, { state: "ready" });
    calls.length = 0;
    const next = v1();
    (next.layout as { children: Array<{ node: { binding?: DataBinding } }> })
      .children[0]!.node.binding = bind("h-alt");
    const r = handle.update(next);
    expect(r.rebound).toEqual(["p99"]);
    expect(calls).toEqual(["patch:p99", "update:p99"]);
    expect(host.querySelector("[data-widget-id='p99'] span")?.textContent).toBe("p99=99|ready");
    calls.length = 0;
    store.setValue("h-p99", 1, { state: "ready" }); // the OLD handle: nobody listens any more
    store.setValue("h-alt", 100, { state: "ready" });
    store.setValue("h-phase", "done", { state: "ready" }); // unchanged binding still live
    await Promise.resolve();
    expect(calls.sort()).toEqual(["update:p99", "update:phase"]);
    handle.dispose();
  });

  it("container styles are patched in place; a container TYPE change remounts that container's widgets", () => {
    const { host, handle, calls } = setup();
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
    expect(
      host.querySelector("[data-widget-id='p99'] [data-placeholder='error']")?.textContent
    ).toBe("[Renderer error for MetricCard: cannot relabel]");
    expect(reg.calls).toContain("patch:phase");
    // The failed widget was TORN DOWN, not just hidden: its handle was disposed once…
    expect(calls).toEqual(["dispose:p99"]);
    handle.dispose();
    expect(calls).toEqual(["dispose:p99"]); // …and the teardown does not dispose it twice.
  });

  it("a renderer that throws from update is torn down: disposed once, unsubscribed, and never disposed twice", () => {
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
    const { host, handle } = setup();
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
    handle.dispose();
  });

  it("title, blueprint id and projection placeholders are patched; update after dispose is a reported no-op", () => {
    const { host, handle, calls } = setup();
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
    handle.dispose();
    calls.length = 0;
    const r = handle.update(v1());
    expect(r.findings).toEqual([{ code: "patch-failed", nodeId: "", message: "disposed" }]);
    expect(r.remounted).toEqual([]);
    expect(calls).toEqual([]);
  });
});
