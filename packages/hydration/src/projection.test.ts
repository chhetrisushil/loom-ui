import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HYDRATION_SET_EVENT,
  HydrationStore,
  hydrationProjection,
  isReservedHandle,
} from "./projection";

const mk = () => new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });

describe("hydrationProjection", () => {
  it("declares its id and a semver version (what the compiler pins)", () => {
    const p = hydrationProjection();
    expect(p.id).toBe(HYDRATION_PROJECTION_ID);
    expect(p.version).toBe(HYDRATION_PROJECTION_VERSION);
    expect(HYDRATION_PROJECTION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.initialState).toEqual({ values: {}, status: {} });
  });
});

describe("HydrationStore", () => {
  it("starts empty and records status and value per handle with an increasing seq", () => {
    const s = mk();
    expect(s.status("h1")).toBeUndefined();
    s.setStatus("h1", { state: "pending" });
    s.setValue("h1", 42, { state: "ready" });
    expect(s.status("h1")).toEqual({ state: "ready", seq: 2 });
    expect(s.value("h1")).toBe(42);
    expect(s.state()).toEqual({ values: { h1: 42 }, status: { h1: { state: "ready", seq: 2 } } });
    expect(s.handles()).toEqual(["h1"]);
  });
  it("a status-only set keeps the last value (stale data stays on screen)", () => {
    const s = mk();
    s.setValue("h1", 1, { state: "ready" });
    s.setStatus("h1", {
      state: "stale",
      finding: { code: "output-shape-drift", severity: "error", message: "m" },
    });
    expect(s.value("h1")).toBe(1);
    expect(s.status("h1")?.state).toBe("stale");
  });
  it("remove drops value and status", () => {
    const s = mk();
    s.setValue("h1", 1, { state: "ready" });
    s.remove("h1");
    expect(s.value("h1")).toBeUndefined();
    expect(s.status("h1")).toBeUndefined();
    expect(s.handles()).toEqual([]);
  });
  it("remove of an unknown handle is a no-op that returns the same state object", () => {
    const s = mk();
    const before = s.state();
    s.remove("never-set");
    expect(s.state()).toBe(before);
  });
  it("subscribe fires for its own handle only, and not on subscribe", async () => {
    const s = mk();
    const seen: string[] = [];
    s.subscribe("h1", (slice) => seen.push(`h1:${slice.status?.state}`));
    s.subscribe("h2", (slice) => seen.push(`h2:${slice.status?.state}`));
    s.setStatus("h1", { state: "pending" });
    s.setValue("h1", 5, { state: "ready" });
    await Promise.resolve();
    expect(seen).toEqual(["h1:pending", "h1:ready"]);
  });
  it("runtimeSubscribe fires on any handle's change, with the whole state", () => {
    const s = mk();
    const seen: unknown[] = [];
    s.runtimeSubscribe((state) => seen.push(state));
    s.setValue("h1", 1, { state: "ready" });
    s.setStatus("h2", { state: "pending" });
    expect(seen).toEqual([
      { values: { h1: 1 }, status: { h1: { state: "ready", seq: 1 } } },
      {
        values: { h1: 1 },
        status: { h1: { state: "ready", seq: 1 }, h2: { state: "pending", seq: 2 } },
      },
    ]);
  });
  it("refuses prototype-shaped handles, and a rejected write does not consume a seq", () => {
    expect(isReservedHandle("__proto__")).toBe(true);
    expect(isReservedHandle("constructor")).toBe(true);
    expect(isReservedHandle("prototype")).toBe(true);
    expect(isReservedHandle("h1")).toBe(false);
    const s = mk();
    expect(() => s.setStatus("__proto__", { state: "pending" })).toThrow(/reserved/);
    expect(s.state()).toEqual({ values: {}, status: {} });
    s.setStatus("h1", { state: "pending" });
    expect(s.status("h1")).toEqual({ state: "pending", seq: 1 });
  });
  it("two viewers of one experience are isolated even on a shared runtime", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const alice = new HydrationStore(runtime, { experienceId: "exp-1", principalId: "alice" });
    const bob = new HydrationStore(runtime, { experienceId: "exp-1", principalId: "bob" });
    expect(alice.scope).toEqual({ experienceId: "exp-1", principalId: "alice" });
    expect(alice.executionId).toBe("exp-1:alice");
    expect(bob.executionId).toBe("exp-1:bob");
    const seen: unknown[] = [];
    bob.subscribe("h", (slice) => seen.push(slice));
    alice.setValue("h", { secret: 1 }, { state: "ready" });
    await Promise.resolve();
    expect(alice.value("h")).toEqual({ secret: 1 });
    expect(bob.value("h")).toBeUndefined();
    expect(bob.status("h")).toBeUndefined();
    expect(seen).toEqual([]); // the other viewer's widget is not even woken
  });
  it("a scope with no principal keys on the experience alone", () => {
    const s = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    expect(s.executionId).toBe("exp-1");
  });
  it("the fold itself refuses a reserved handle from a forged envelope on the shared runtime, never assigning through a prototype setter", () => {
    const runtime = new InMemoryProjectionRuntime();
    const s = new HydrationStore(runtime, { experienceId: "exp-1" });
    runtime.handleEvent({
      id: "forged",
      workflowId: "x",
      executionId: "exp-1",
      eventType: HYDRATION_SET_EVENT,
      sequence: 999,
      timestamp: 0,
      payload: {
        kind: "value",
        handle: "__proto__",
        value: { polluted: true },
        status: { state: "ready", seq: 1 },
      },
    });
    expect(s.state()).toEqual({ values: {}, status: {} });
    expect(Object.getPrototypeOf(s.state().values)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    s.setValue("h1", 1, { state: "ready" });
    s.remove("h1");
    expect(Object.getPrototypeOf(s.state().values)).toBe(Object.prototype);
  });
});
