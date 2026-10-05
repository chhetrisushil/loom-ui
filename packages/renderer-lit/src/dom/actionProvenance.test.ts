import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { isStaleAction } from "@loom-ui/core/browser";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { type WidgetAction, blueprint$, customWidget$, flex } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { frameMessage } from "../sandbox/protocol";
import { createLitRegistry, renderBlueprintDom } from "./index";

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
});
