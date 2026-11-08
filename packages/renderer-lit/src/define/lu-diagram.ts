import { defineElement } from "../define";
import { LuDiagram } from "../widgets/lu-diagram";

/** Register `<lu-diagram>`. Idempotent. */
export function defineDiagram(): void {
  defineElement("lu-diagram", LuDiagram);
}
