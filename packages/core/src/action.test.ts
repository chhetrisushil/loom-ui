import { describe, expect, it } from "vitest";
import { actionFreshness, isStaleAction, parseBlueprintId, viewedVersionOf } from "./action";

const head = { experienceId: "exp-1", versionHash: "sha256:v2" };

describe("action provenance", () => {
  it("parses a Blueprint id into experience id and version hash ('@' in the id is fine)", () => {
    expect(parseBlueprintId("exp-1@sha256:abc")).toEqual({
      experienceId: "exp-1",
      versionHash: "sha256:abc",
    });
    expect(parseBlueprintId("a@b@sha256:abc").experienceId).toBe("a@b");
    expect(parseBlueprintId("exp-1@unsealed").versionHash).toBe("");
  });

  it("an action stamped with the current head is fresh; an older one is stale", () => {
    const fresh = { viewedVersion: viewedVersionOf("exp-1@sha256:v2") };
    const old = { viewedVersion: viewedVersionOf("exp-1@sha256:v1") };
    expect(actionFreshness(fresh, head)).toBe("fresh");
    expect(isStaleAction(fresh, head)).toBe(false);
    expect(actionFreshness(old, head)).toBe("stale");
    expect(isStaleAction(old, head)).toBe(true);
  });

  it("fails closed: an unstamped action, an unsealed view or head, a different experience", () => {
    expect(actionFreshness({}, head)).toBe("unstamped");
    expect(isStaleAction({}, head)).toBe(true);
    expect(isStaleAction({ viewedVersion: viewedVersionOf("exp-1@unsealed") }, head)).toBe(true);
    expect(
      isStaleAction(
        { viewedVersion: viewedVersionOf("exp-1@sha256:v2") },
        { ...head, versionHash: "" }
      )
    ).toBe(true);
    expect(isStaleAction({ viewedVersion: viewedVersionOf("exp-2@sha256:v2") }, head)).toBe(true);
    // a forged stamp that is not even shaped like one
    expect(isStaleAction({ viewedVersion: { versionHash: 7 } as never }, head)).toBe(true);
  });

  it("carries the binding the user saw", () => {
    expect(viewedVersionOf("e@h", { state: "stale", seq: 3 }).binding).toEqual({
      state: "stale",
      seq: 3,
    });
    expect(viewedVersionOf("e@h").binding).toBeUndefined();
  });
});
