import { defineElement } from "../define";
import { LuDataTable } from "../widgets/lu-data-table";

/** Register `<lu-data-table>`. Idempotent. */
export function defineDataTable(): void {
  defineElement("lu-data-table", LuDataTable);
}
