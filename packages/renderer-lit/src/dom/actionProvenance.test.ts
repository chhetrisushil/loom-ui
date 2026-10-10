import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import {
  type StampedAction,
  actionFreshness,
  compileFingerprint,
  isStaleAction,
} from "@loom-ui/core/browser";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { type WidgetAction, blueprint$, customWidget$, flex } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { frameMessage } from "../sandbox/protocol";
import { createLitRegistry, renderBlueprintDom } from "./index";
import type { DomWidgetRenderer } from "./registry";
import "../register";

const bind = (h: string) => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(h),
  status: { path: hydrationStatusPath(h) },
});
const approval = customWidget$({
  kind: "ApprovalCard",
  id: "ap",
  title: "Deploy",
  binding: bind("h-ap"),
});
const a2ui = customWidget$({
  kind: "A2UIView",
  id: "a2",
  title: "Form",
  binding: bind("h-a2"),
  props: {
    view: {
      nodes: [
        {
          id: "root",
          component: "Button",
          label: "Go",
          action: "go",
          context: { viewedVersion: "forged" },
        },
      ],
    },
  },
});
const sandbox = customWidget$({
  kind: "SandboxView",
  id: "sb",
  title: "Custom",
  binding: bind("h-sb"),
  props: { code: "root.textContent = 'x'" },
});
const bpAt = (id: string) =>
  blueprint$({
    id,
    title: "T",
    layout: flex({ direction: "column", children: [approval, a2ui, sandbox] }),
    projections: [HYDRATION_PROJECTION_ID],
  });

const setup = (onAction?: (a: WidgetAction) => void) => {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "e" });
  store.setValue("h-ap", true, { state: "ready" });
  store.setValue("h-a2", { t: 1 }, { state: "ready" });
  store.setValue("h-sb", { t: 1 }, { state: "ready" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = renderBlueprintDom(host, bpAt("e@sha256:v1"), {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: createLitRegistry(),
    ...(onAction && { onAction }),
  });
  return { host, handle, store };
};
const tick = () => new Promise((r) => setTimeout(r, 20));
const deep = (host: HTMLElement, widgetId: string, sel: string): HTMLElement | null => {
  const w = host.querySelector(`[data-widget-id='${widgetId}']`)?.firstElementChild as HTMLElement;
  return (w?.shadowRoot?.querySelector(sel) as HTMLElement) ?? null;
};

describe("action provenance", () => {
  it("an ApprovalCard action carries the viewed version; after a recompose the old one is stale and a new one fresh", async () => {
    const seen: (WidgetAction & { viewedVersion?: unknown })[] = [];
    const { host, handle } = setup((a) => seen.push(a));
    await tick();
    (deep(host, "ap", "button") as HTMLButtonElement).click();
    expect(seen[0]).toMatchObject({
      type: "APPROVE",
      widgetId: "ap",
      payload: { approved: true },
      viewedVersion: {
        blueprintId: "e@sha256:v1",
        experienceId: "e",
        versionHash: "sha256:v1",
        binding: { state: "ready" },
      },
    });
    handle.update(bpAt("e@sha256:v2"));
    await tick();
    (deep(host, "ap", "button") as HTMLButtonElement).click();
    const head = { experienceId: "e", versionHash: "sha256:v2" };
    expect(isStaleAction(seen[0] as never, head)).toBe(true);
    expect(isStaleAction(seen[1] as never, head)).toBe(false);
  });

  it("A2UI buttons arrive via onAction with provenance; payload fields cannot override it", async () => {
    const seen: WidgetAction[] = [];
    const { host } = setup((a) => seen.push(a));
    await tick();
    const inner = host
      .querySelector("[data-widget-id='a2']")
      ?.firstElementChild?.shadowRoot?.querySelector("lu-a2ui-view") as HTMLElement;
    (inner.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "A2UI_ACTION",
      widgetId: "a2",
      payload: { action: "go" },
      viewedVersion: { versionHash: "sha256:v1" },
    });
  });

  it("sandbox actions arrive via onAction with provenance; a frame cannot set viewedVersion or widgetId", async () => {
    const seen: WidgetAction[] = [];
    const { host } = setup((a) => seen.push(a));
    await tick();
    const inner = host
      .querySelector("[data-widget-id='sb']")
      ?.firstElementChild?.shadowRoot?.querySelector("lu-sandbox") as HTMLElement;
    const frame = inner.shadowRoot?.querySelector("iframe") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: frameMessage({
          type: "action",
          action: "x",
          context: { viewedVersion: { versionHash: "sha256:forged" }, widgetId: "ap" },
        }),
        source: frame.contentWindow,
      })
    );
    expect(seen).toHaveLength(1);
    const a = seen[0] as WidgetAction & { viewedVersion: { versionHash: string } };
    expect(a.type).toBe("SANDBOX_ACTION");
    expect(a.widgetId).toBe("sb");
    expect(a.viewedVersion.versionHash).toBe("sha256:v1");
    expect(a.payload).toMatchObject({ action: "x" });
  });

  it("a host without onAction behaves as before: nothing throws, the DOM event still fires", async () => {
    const { host } = setup();
    await tick();
    expect(() => (deep(host, "ap", "button") as HTMLButtonElement).click()).not.toThrow();
    const inner = host
      .querySelector("[data-widget-id='a2']")
      ?.firstElementChild?.shadowRoot?.querySelector("lu-a2ui-view") as HTMLElement;
    const events: unknown[] = [];
    inner.addEventListener("a2ui-action", (e) => events.push((e as CustomEvent).detail));
    (inner.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
    expect(events).toHaveLength(1);
  });

  const approvalAt = (h: string) =>
    customWidget$({ kind: "ApprovalCard", id: "ap", title: "Deploy", binding: bind(h) });
  const bpWith = (id: string, w: ReturnType<typeof approvalAt>) =>
    blueprint$({
      id,
      title: "T",
      layout: flex({ direction: "column", children: [w] }),
      projections: [HYDRATION_PROJECTION_ID],
    });
  const mountBp = (
    bp: ReturnType<typeof bpWith>,
    extra: Partial<Parameters<typeof renderBlueprintDom>[2]> = {}
  ) => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    store.setValue("h-ap", 100, { state: "ready" });
    store.setValue("h-ap2", 7, { state: "ready" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const seen: (WidgetAction & StampedAction)[] = [];
    const handle = renderBlueprintDom(host, bp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: createLitRegistry(),
      onAction: (a) => seen.push(a),
      ...extra,
    });
    return { host, handle, store, seen };
  };
  const click = (host: HTMLElement) => (deep(host, "ap", "button") as HTMLButtonElement).click();

  it("P1-a: the stamped seq is the data the widget was last DELIVERED, not a mount-time snapshot", async () => {
    const { host, handle, store, seen } = mountBp(bpWith("e@sha256:v1", approvalAt("h-ap")));
    await tick();
    click(host);
    const seq1 = seen[0]?.viewedVersion?.binding?.seq;
    store.setValue("h-ap", 500000, { state: "ready" });
    await tick();
    click(host);
    const seq2 = seen[1]?.viewedVersion?.binding?.seq;
    expect(seq2).toBeGreaterThan(seq1 ?? Number.POSITIVE_INFINITY);
    expect(seq2).toBe(handle.head().bindingSeq?.("ap"));
    // a later update() of an unrelated change must not re-stamp from a different snapshot
    store.setValue("h-sb", 1, { state: "ready" });
    handle.update(bpWith("e@sha256:v1", { ...approvalAt("h-ap"), title: "Deploy 2" } as never));
    await tick();
    click(host);
    expect(seen[2]?.viewedVersion?.binding?.seq).toBe(seq2);
  });

  it("P1-b: the default check refuses an action whose DATA moved under an unchanged composition", async () => {
    const { host, handle, store, seen } = mountBp(bpWith("e@sha256:v1", approvalAt("h-ap")));
    await tick();
    click(host);
    expect(isStaleAction(seen[0] as never, handle.head())).toBe(false);
    store.setValue("h-ap", 999, { state: "ready" });
    expect(actionFreshness(seen[0] as never, handle.head())).toBe("data-moved");
    expect(isStaleAction(seen[0] as never, handle.head())).toBe(true);
  });

  it("P2-a: a sandbox message queued before update(v3) is stamped with the view it ran against", async () => {
    const { host, handle, seen } = setupSandbox();
    await tick();
    const inner = host
      .querySelector("[data-widget-id='sb']")
      ?.firstElementChild?.shadowRoot?.querySelector("lu-sandbox") as HTMLElement;
    const frame = inner.shadowRoot?.querySelector("iframe") as HTMLIFrameElement;
    handle.update(bpAt("e@sha256:v3"));
    // handled AFTER the commit but BEFORE any frame has painted v3
    window.dispatchEvent(
      new MessageEvent("message", {
        data: frameMessage({ type: "action", action: "x", context: null }),
        source: frame.contentWindow,
      })
    );
    expect(seen[0]?.viewedVersion?.versionHash).toBe("sha256:v1");
    expect(isStaleAction(seen[0] as never, { experienceId: "e", versionHash: "sha256:v3" })).toBe(
      true
    );
    await tick();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: frameMessage({ type: "action", action: "y", context: null }),
        source: frame.contentWindow,
      })
    );
    expect(seen[1]?.viewedVersion?.versionHash).toBe("sha256:v3");
  });

  it("P2-a: a click after the commit but before the next frame is stamped with the old id", async () => {
    const { host, handle, seen } = mountBp(bpWith("e@sha256:v1", approvalAt("h-ap")));
    await tick();
    handle.update(bpWith("e@sha256:v2", { ...approvalAt("h-ap"), title: "Deploy 2" } as never));
    click(host);
    expect(seen[0]?.viewedVersion?.versionHash).toBe("sha256:v1");
    await tick();
    click(host);
    expect(seen[1]?.viewedVersion?.versionHash).toBe("sha256:v2");
  });

  it("P3: a paused animation frame (background tab) does not hold the old id forever", async () => {
    const realRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0; // never fires
    try {
      const { host, handle, seen } = mountBp(bpWith("e@sha256:v1", approvalAt("h-ap")));
      await tick();
      handle.update(bpWith("e@sha256:v2", { ...approvalAt("h-ap"), title: "Deploy 2" } as never));
      click(host);
      expect(seen[0]?.viewedVersion?.versionHash).toBe("sha256:v1");
      await new Promise((r) => setTimeout(r, 300));
      click(host);
      expect(seen[1]?.viewedVersion?.versionHash).toBe("sha256:v2");
    } finally {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = realRaf;
    }
  });

  it("P2-a: a 3P widget calling onAction after dispose (or after a remount) is dropped", () => {
    let kept: ((a: WidgetAction) => void) | undefined;
    const reg = createLitRegistry();
    reg.register("Gizmo", ((_h, p) => {
      kept = p.onAction;
      return { update() {}, dispose() {} };
    }) as DomWidgetRenderer);
    const bp = bpWith("e@sha256:v1", customWidget$({ kind: "Gizmo", id: "ap", title: "g" }));
    const { handle, seen } = mountBp(bp, { registry: reg });
    kept?.({ type: "LIVE", widgetId: "" });
    expect(seen).toHaveLength(1);
    handle.dispose();
    kept?.({ type: "DEAD", widgetId: "" });
    expect(seen).toHaveLength(1);
  });

  it("P2-b: a rebound widget stamps its NEW binding's seq", async () => {
    const { host, handle, store, seen } = mountBp(bpWith("e@sha256:v1", approvalAt("h-ap")));
    await tick();
    store.setValue("h-ap2", 8, { state: "ready" });
    store.setValue("h-ap2", 9, { state: "ready" });
    handle.update(bpWith("e@sha256:v2", approvalAt("h-ap2")));
    await tick();
    click(host);
    const stamped = seen[0]?.viewedVersion;
    expect(stamped?.versionHash).toBe("sha256:v2");
    expect(stamped?.binding?.seq).toBe(handle.head().bindingSeq?.("ap"));
    expect(isStaleAction(seen[0] as never, handle.head())).toBe(false);
  });

  it("P3: the compile fingerprint is stamped, and a different view of the same artifact is stale", async () => {
    const fp = compileFingerprint({ clearance: "internal", restrictedHandles: ["h-x"] });
    const { host, handle, seen } = mountBp(bpWith("e@sha256:v1", approvalAt("h-ap")), {
      compile: fp,
    });
    await tick();
    click(host);
    expect(seen[0]?.viewedVersion?.compile).toBe(fp);
    expect(isStaleAction(seen[0] as never, handle.head())).toBe(false);
    expect(
      isStaleAction(seen[0] as never, {
        ...handle.head(),
        compile: compileFingerprint({ clearance: "secret" }),
      })
    ).toBe(true);
  });

  it("P3: head() is the COMMITTED head — a refused update does not advance it", async () => {
    const { handle } = mountBp(bpWith("e@sha256:v1", approvalAt("h-ap")));
    expect(handle.head()).toMatchObject({ experienceId: "e", versionHash: "sha256:v1" });
    const bad = bpWith("e@sha256:v2", undefined as never);
    handle.update({
      ...bad,
      layout: flex({ direction: "column", children: [undefined as never] }),
    });
    expect(handle.head().versionHash).toBe("sha256:v1");
    handle.update(bpWith("e@sha256:v2", approvalAt("h-ap")));
    expect(handle.head().versionHash).toBe("sha256:v2");
  });

  it("P3: a custom renderer's top-level viewedVersion / widgetId are overwritten by the stamp", () => {
    let emit: ((a: WidgetAction) => void) | undefined;
    const reg = createLitRegistry();
    reg.register("Gizmo", ((_h, p) => {
      emit = p.onAction;
      return { update() {}, dispose() {} };
    }) as DomWidgetRenderer);
    const bp = bpWith("e@sha256:v1", customWidget$({ kind: "Gizmo", id: "gz", title: "g" }));
    const { seen } = mountBp(bp, { registry: reg });
    emit?.({
      type: "T",
      widgetId: "forged",
      viewedVersion: { blueprintId: "e@sha256:forged", versionHash: "sha256:forged" },
      payload: { n: 1 },
    } as never);
    expect(seen[0]?.widgetId).toBe("gz");
    expect(seen[0]?.viewedVersion?.versionHash).toBe("sha256:v1");
    expect(seen[0]?.payload).toEqual({ n: 1 });
  });

  it("P3: with onAction wired the DOM a2ui-action event is NOT fired (no unverifiable twin)", async () => {
    const { host } = setup(() => {});
    await tick();
    const inner = host
      .querySelector("[data-widget-id='a2']")
      ?.firstElementChild?.shadowRoot?.querySelector("lu-a2ui-view") as HTMLElement;
    const events: unknown[] = [];
    inner.addEventListener("a2ui-action", (e) => events.push(e));
    (inner.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
    expect(events).toHaveLength(0);
  });
});

function setupSandbox() {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "e" });
  store.setValue("h-ap", true, { state: "ready" });
  store.setValue("h-a2", { t: 1 }, { state: "ready" });
  store.setValue("h-sb", { t: 1 }, { state: "ready" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const seen: (WidgetAction & StampedAction)[] = [];
  const handle = renderBlueprintDom(host, bpAt("e@sha256:v1"), {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: createLitRegistry(),
    onAction: (a) => seen.push(a),
  });
  return { host, handle, seen };
}
