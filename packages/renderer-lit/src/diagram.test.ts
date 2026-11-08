import { builtinCatalog, catalogCoverage } from "@loom/blueprint-runtime";
import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createDiagramLitRegistry, diagramKindContracts, registerDiagramWidgets } from "./diagram";
import { createLitRegistry, litRegistry } from "./dom/litRegistry";
import "./register";

describe("the opt-in diagram entry", () => {
  it("registers Diagram on top of the default registry, which keeps loom's built-ins covered", () => {
    const reg = createDiagramLitRegistry();
    expect(reg.has("Diagram")).toBe(true);
    expect(catalogCoverage(builtinCatalog, reg).missing).toEqual([]);
    expect(diagramKindContracts).toEqual([
      { kind: "Diagram", props: ["timeFormat"], binding: "required" },
    ]);
    expect(registerDiagramWidgets(createLitRegistry())).toBeDefined();
  });

  it("the default registry draws a fixed placeholder, the entry draws the diagram", () => {
    const widget = customWidget$({
      kind: "Diagram",
      id: "d",
      title: "T",
      binding: { projectionId: "p", path: "v" },
    });
    const value = { layout: "network", nodes: [{ id: "a", label: "A" }], edges: [] };
    const drawn = (reg: typeof litRegistry): string => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      (reg.get("Diagram") as NonNullable<ReturnType<typeof reg.get>>)(host, { widget, value });
      return host.firstElementChild?.tagName.toLowerCase() ?? "";
    };
    expect(drawn(litRegistry)).toBe("lu-diagram-missing");
    expect(drawn(createDiagramLitRegistry())).toBe("lu-diagram");
  });
});
