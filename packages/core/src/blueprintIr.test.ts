import { BLUEPRINT_IR_VERSION } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";

// compile.ts emits a loom `Blueprint` field by field. loom's ADR 0096 makes that shape a
// versioned IR precisely so an external framework compiling to it is not silently broken by a
// field added, renamed or flipped between required and optional — but the version only protects
// a consumer that reads it. Nothing else in this repo does, so this is the read: a pin that turns
// an upstream IR bump into a red test here instead of a subtly wrong blueprint in production.
describe("the loom Blueprint IR this compiler targets", () => {
  it("is the version compile.ts was written against", () => {
    expect(
      BLUEPRINT_IR_VERSION,
      "loom's Blueprint IR changed — review compile.ts and bump deliberately"
    ).toBe("1.0.0");
  });
});
