import { defineElement } from "../define.js";
import { LuDiagramMissing } from "../widgets/lu-diagram-missing.js";

/** Register `<lu-diagram-missing>`. Idempotent. */
export function defineDiagramMissing(): void {
  defineElement("lu-diagram-missing", LuDiagramMissing);
}
