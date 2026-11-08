import { defineElement } from "../define";
import { LuDiagramMissing } from "../widgets/lu-diagram-missing";

/** Register `<lu-diagram-missing>`. Idempotent. */
export function defineDiagramMissing(): void {
  defineElement("lu-diagram-missing", LuDiagramMissing);
}
