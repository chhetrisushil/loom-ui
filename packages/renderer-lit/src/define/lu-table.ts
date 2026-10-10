import { defineElement } from "../define";
import { LuTable } from "../widgets/lu-table";

/** Register `<lu-table>`. Idempotent. */
export function defineTable(): void {
  defineElement("lu-table", LuTable);
}
