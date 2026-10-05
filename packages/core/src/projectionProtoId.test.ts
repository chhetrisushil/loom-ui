import { describe, expect, it } from "vitest";
import { ProjectionBinding } from "./node";

describe("projection id `__proto__` (U2 review P3)", () => {
  it("is refused: a class held for it could not be bound by the content address", () => {
    const r = ProjectionBinding.safeParse({ id: "__proto__", path: "a", version: "1" });
    expect(r.success).toBe(false);
  });
  it("an ordinary id still parses", () => {
    expect(
      ProjectionBinding.safeParse({ id: "agent-status", path: "a", version: "1" }).success
    ).toBe(true);
  });
});
