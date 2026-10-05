import { describe, expect, it } from "vitest";
import {
  actionFreshness,
  compileFingerprint,
  isStaleAction,
  parseBlueprintId,
  viewedVersionOf,
} from "./action";

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

  it("data moved: same composition, different binding seq is data-moved (stale)", () => {
    const a = {
      widgetId: "ap",
      viewedVersion: viewedVersionOf("exp-1@sha256:v2", { state: "ready", seq: 1 }),
    };
    expect(actionFreshness(a, { ...head, bindingSeq: () => 1 })).toBe("fresh");
    expect(actionFreshness(a, { ...head, bindingSeq: () => 2 })).toBe("data-moved");
    expect(isStaleAction(a, { ...head, bindingSeq: () => 2 })).toBe(true);
    // the resolver is asked about the action's widget
    const asked: string[] = [];
    actionFreshness(a, {
      ...head,
      bindingSeq: (w) => {
        asked.push(w);
        return 1;
      },
    });
    expect(asked).toEqual(["ap"]);
  });

  it("fails closed on data: a binding with no seq, an unknown current seq, a throwing resolver", () => {
    const noSeq = {
      widgetId: "ap",
      viewedVersion: viewedVersionOf("exp-1@sha256:v2", { state: "ready" }),
    };
    expect(actionFreshness(noSeq, { ...head, bindingSeq: () => 1 })).toBe("unverifiable");
    const a = {
      widgetId: "ap",
      viewedVersion: viewedVersionOf("exp-1@sha256:v2", { state: "ready", seq: 1 }),
    };
    expect(actionFreshness(a, { ...head, bindingSeq: () => undefined })).toBe("unverifiable");
    expect(
      actionFreshness(a, {
        ...head,
        bindingSeq: () => {
          throw new Error("x");
        },
      })
    ).toBe("unverifiable");
    // no resolver: unchanged behaviour; an unbound widget needs no seq
    expect(actionFreshness(a, head)).toBe("fresh");
    expect(
      actionFreshness(
        { widgetId: "n", viewedVersion: viewedVersionOf("exp-1@sha256:v2") },
        { ...head, bindingSeq: () => 9 }
      )
    ).toBe("fresh");
  });

  it("compile fingerprint: a different view of the same artifact is stale; missing is unverifiable", () => {
    const restricted = compileFingerprint({ clearance: "internal", restrictedHandles: ["h1"] });
    const full = compileFingerprint({ clearance: "secret" });
    const seen = { viewedVersion: viewedVersionOf("exp-1@sha256:v2", undefined, restricted) };
    expect(actionFreshness(seen, { ...head, compile: restricted })).toBe("fresh");
    expect(actionFreshness(seen, { ...head, compile: full })).toBe("stale");
    expect(
      actionFreshness(
        { viewedVersion: viewedVersionOf("exp-1@sha256:v2") },
        { ...head, compile: full }
      )
    ).toBe("unverifiable");
    expect(actionFreshness(seen, head)).toBe("fresh");
  });

  it("compileFingerprint is deterministic, handle-order-insensitive and input-sensitive", () => {
    const f = (i: Parameters<typeof compileFingerprint>[0]) => compileFingerprint(i);
    expect(f({ restrictedHandles: ["a", "b"] })).toBe(f({ restrictedHandles: ["b", "a"] }));
    expect(f({ locale: "en" })).not.toBe(f({ locale: "fr" }));
    expect(f({ clearance: "secret" })).not.toBe(f({}));
    expect(f({ restrictedHandles: ["a"] })).not.toBe(f({ restrictedHandles: ["a", "b"] }));
  });
});
