import { defineElement } from "../define.js";
import { LuMetricCard } from "../widgets/lu-metric-card.js";

/** Register `<lu-metric-card>`. Idempotent. */
export function defineMetricCard(): void {
  defineElement("lu-metric-card", LuMetricCard);
}
