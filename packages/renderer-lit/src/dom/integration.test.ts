import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, StatusBadge, blueprint$, grid } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { litRegistry } from "./litRegistry";
import { renderBlueprintDom } from "./renderBlueprintDom";

// ── The seam, end to end ──────────────────────────────────────────────────────
// Every other test in this package exercises ONE of: the DOM adapter (with a fake registry),
// the Lit widgets (mounted by hand), or the store. This one runs the whole chain a consumer
// actually runs — blueprint → runtime → store → adapter → real Lit elements → shadow DOM —
// because each of those seams was green in isolation while the pair could still be wrong.

/** A hydration binding, IR 2.0.0: the value path and the status path beside it. */
const bind = (handle: string) => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
  status: { path: hydrationStatusPath(handle) },
});

const bp = blueprint$({
  id: "e@v",
  title: "Dash",
  layout: grid({
    columns: 12,
    children: [
      MetricCard({
        id: "a",
        title: "p99",
        binding: bind("h-a"),
      }),
      StatusBadge({
        id: "b",
        title: "Phase",
        binding: bind("h-b"),
      }),
    ],
  }),
  projections: [HYDRATION_PROJECTION_ID],
});

interface Updatable extends HTMLElement {
  readonly updateComplete: Promise<unknown>;
}
const el = (host: HTMLElement, widgetId: string, tag: string): Updatable => {
  const found = host.querySelector(`[data-widget-id='${widgetId}'] ${tag}`);
  expect(found).not.toBeNull();
  return found as Updatable;
};
const text = (e: Element): string => (e.shadowRoot?.textContent ?? "").replace(/\s+/g, " ").trim();
const dataState = (e: Element): string | null | undefined =>
  e.shadowRoot?.querySelector("[data-state]")?.getAttribute("data-state");

let hosts: HTMLElement[] = [];
const mountHost = (): HTMLElement => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  return host;
};
afterEach(() => {
  for (const h of hosts) h.remove();
  hosts = [];
});

describe("renderBlueprintDom + litRegistry + HydrationStore", () => {
  it("mounts real Lit elements, drives them from the store, and stops driving them on dispose", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    const host = mountHost();
    const handle = renderBlueprintDom(host, bp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
    });

    const card = el(host, "a", "lu-metric-card");
    const badge = el(host, "b", "lu-status-badge");
    await card.updateComplete;
    await badge.updateComplete;
    // Nothing published yet: both widgets are loading, and the value renderer has not run.
    expect(dataState(card)).toBe("loading");
    expect(dataState(badge)).toBe("loading");

    store.setValue("h-a", 412, { state: "ready" });
    await Promise.resolve();
    await card.updateComplete;
    expect(text(card)).toContain("412");
    expect(dataState(card)).toBe("ready");
    // One handle resolving must not disturb the other widget.
    expect(dataState(badge)).toBe("loading");

    store.setValue("h-b", "triaging", { state: "ready" });
    await Promise.resolve();
    await badge.updateComplete;
    expect(text(badge)).toContain("triaging");

    // A status-only change: the value is unchanged and must stay on screen, decorated.
    store.setStatus("h-a", {
      state: "stale",
      finding: { code: "output-shape-drift", severity: "error", message: "m" },
    });
    await Promise.resolve();
    await card.updateComplete;
    expect(dataState(card)).toBe("stale");
    expect(text(card)).toContain("412");

    handle.dispose();
    expect(host.querySelector("[data-widget-id='a']")).toBeNull();
    expect(card.isConnected).toBe(false);
    expect(badge.isConnected).toBe(false);
    // The subscription went with it: a later publish reaches nothing.
    store.setValue("h-a", 999, { state: "ready" });
    await Promise.resolve();
    await card.updateComplete;
    expect(text(card)).not.toContain("999");
  });

  it("carries a status error through to the element without running the value renderer", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e2" });
    store.setValue("h-a", 412, {
      state: "error",
      finding: { code: "provider-failed", severity: "error", message: "tool down" },
    });
    const host = mountHost();
    renderBlueprintDom(host, bp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
    });
    const card = el(host, "a", "lu-metric-card");
    await card.updateComplete;
    // Mounted from the store's CURRENT state, not only from later events.
    expect(dataState(card)).toBe("error");
    expect(text(card)).toContain("tool down");
    expect(text(card)).not.toContain("412");
  });

  it("an empty status after a ready value draws 'No data' — the store dropped the value, nothing stale shows", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e3" });
    store.setValue("h-a", 412, { state: "ready" });
    const host = mountHost();
    renderBlueprintDom(host, bp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
    });
    const card = el(host, "a", "lu-metric-card");
    await card.updateComplete;
    expect(text(card)).toContain("412");
    store.setStatus("h-a", {
      state: "empty",
      finding: { code: "upstream-empty", severity: "warn", message: "no data for this view" },
    });
    await card.updateComplete;
    expect(dataState(card)).toBe("empty");
    expect(text(card)).toBe("p99: No data");
    expect(store.value("h-a")).toBeUndefined();
    expect(card.shadowRoot?.querySelector('[role="status"]')).not.toBeNull();
  });
});
