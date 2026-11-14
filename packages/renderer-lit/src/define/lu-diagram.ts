import { defineElement } from "../define.js";
import { LuDiagram } from "../widgets/lu-diagram.js";

/** Register `<lu-diagram>`. Idempotent. */
export function defineDiagram(): void {
  defineElement("lu-diagram", LuDiagram);
}
