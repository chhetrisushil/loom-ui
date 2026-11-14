import { defineElement } from "../define.js";
import { LuKpi } from "../widgets/lu-kpi.js";

/** Register `<lu-kpi>`. Idempotent. */
export function defineKpi(): void {
  defineElement("lu-kpi", LuKpi);
}
