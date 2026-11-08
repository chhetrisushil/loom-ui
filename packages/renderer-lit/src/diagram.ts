// `@loom-ui/renderer-lit/diagram` — the `Diagram` widget, opt-in.
//
// Creating a registry here (or `registerDiagramWidgets`) defines the `lu-diagram` element. It is its
// own entry, like the media and chat widgets, so a page that draws no diagram does not pay for the
// layout math and the drawer. The kind itself (and the `DiagramValue` contract, with its caps and
// structural rules) is universal and lives in `@loom-ui/core`; this entry is only how the web
// surface DRAWS it.
//
//   import { createDiagramLitRegistry } from "@loom-ui/renderer-lit/diagram";
//   renderBlueprintDom(host, blueprint, { registry: createDiagramLitRegistry() });
//
// Compose with the other opt-in entries by registering on one registry:
// `registerDiagramWidgets(registerChatWidgets(createLitRegistry()))`.

import type { CatalogEntry } from "@loom/blueprint-runtime";
import { defineDiagram } from "./define/lu-diagram";
import { type LitRegistryOptions, createLitRegistry, elementRenderer } from "./dom/litRegistry";
import type { DomRegistry } from "./dom/registry";

export { LuDiagram } from "./widgets/lu-diagram";
export {
  type DiagramGeometry,
  type PlacedEdge,
  type PlacedNode,
  layoutDiagram,
} from "./charts/diagramLayout";

/** The loom contract the Diagram kind declares (what a catalogue's `surfaces.web` carries for it). */
export const diagramKindContracts: readonly CatalogEntry[] = [
  // `timeFormat` as a prop is the fallback for a value that declares none (a timeline's date labels).
  { kind: "Diagram", props: ["timeFormat"], binding: "required" },
];

/** Register the Diagram kind on `registry` (returned, for chaining). */
export function registerDiagramWidgets(
  registry: DomRegistry,
  opts: LitRegistryOptions = {}
): DomRegistry {
  defineDiagram();
  registry.register("Diagram", elementRenderer("lu-diagram", opts));
  return registry;
}

/** A NEW default registry with the Diagram kind added. */
export function createDiagramLitRegistry(opts: LitRegistryOptions = {}): DomRegistry {
  return registerDiagramWidgets(createLitRegistry(opts), opts);
}
