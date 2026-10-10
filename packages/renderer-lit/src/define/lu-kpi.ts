import { defineElement } from "../define";
import { LuKpi } from "../widgets/lu-kpi";

/** Register `<lu-kpi>`. Idempotent. */
export function defineKpi(): void {
  defineElement("lu-kpi", LuKpi);
}
