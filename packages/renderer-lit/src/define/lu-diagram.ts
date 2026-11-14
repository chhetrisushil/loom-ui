import { useDiagramContracts } from "@loomwork/ui-core/browser";
import { defineElement } from "../define.js";
import { LuDiagram } from "../widgets/lu-diagram.js";

/** Register `<lu-diagram>`. Idempotent. */
export function defineDiagram(): void {
  // the value contracts these widgets check are deferred in core: load them first
  useDiagramContracts();
  defineElement("lu-diagram", LuDiagram);
}
