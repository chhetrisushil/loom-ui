import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it, vi } from "vitest";
import { createLitRegistry } from "./litRegistry";
import "../widgets/index";

describe("the default registry and media kinds (no media entry loaded)", () => {
  it("draws one fixed placeholder, never an address, and warns once how to fix it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = createLitRegistry();
    const host = document.createElement("div");
    document.body.appendChild(host);
    for (const kind of ["Image", "File"]) {
      const draw = reg.get(kind);
      draw?.(host, {
        widget: customWidget$({
          kind,
          id: kind,
          title: "SECRETTITLE",
          binding: { projectionId: "h", path: "values.h" },
        }),
        value: { address: "sha256:deadbeef0001", mediaType: "image/png" },
      });
    }
    await new Promise((r) => setTimeout(r, 10));
    const els = [...host.querySelectorAll("lu-media-missing")] as HTMLElement[];
    expect(els).toHaveLength(2);
    for (const el of els) {
      const t = el.shadowRoot?.textContent ?? "";
      expect(t).toContain("Media renderer not loaded");
      expect(t + el.shadowRoot?.innerHTML).not.toContain("deadbeef");
      expect(t).not.toContain("SECRETTITLE");
    }
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("createMediaLitRegistry"))
    ).toHaveLength(1);
    warn.mockRestore();
    host.remove();
  });
});
