import { defineElement } from "../define.js";
import { LuTable } from "../widgets/lu-table.js";

/** Register `<lu-table>`. Idempotent. */
export function defineTable(): void {
  defineElement("lu-table", LuTable);
}
