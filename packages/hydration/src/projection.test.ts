import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
  hydrationProjection,
  isReservedHandle,
} from "./projection";

const mk = () => new HydrationStore(new InMemoryProjectionRuntime(), "exp-1");

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
  it("refuses prototype-shaped handles", () => {
    expect(isReservedHandle("__proto__")).toBe(true);
    expect(isReservedHandle("constructor")).toBe(true);
    expect(isReservedHandle("prototype")).toBe(true);
    expect(isReservedHandle("h1")).toBe(false);
    const s = mk();
    expect(() => s.setStatus("__proto__", { state: "pending" })).toThrow(/reserved/);
    expect(s.state()).toEqual({ values: {}, status: {} });
  });
});
