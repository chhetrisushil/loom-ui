import { defineElement } from "../define.js";
import { LuDataTable } from "../widgets/lu-data-table.js";

/** Register `<lu-data-table>`. Idempotent. */
export function defineDataTable(): void {
  defineElement("lu-data-table", LuDataTable);
}
