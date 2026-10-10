import { defineElement } from "../define";
import { LuMetricCard } from "../widgets/lu-metric-card";

/** Register `<lu-metric-card>`. Idempotent. */
export function defineMetricCard(): void {
  defineElement("lu-metric-card", LuMetricCard);
}
