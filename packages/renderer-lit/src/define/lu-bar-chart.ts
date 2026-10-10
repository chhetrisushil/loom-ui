import { defineElement } from "../define";
import { LuBarChart } from "../widgets/lu-bar-chart";

/** Register `<lu-bar-chart>`. Idempotent. */
export function defineBarChart(): void {
  defineElement("lu-bar-chart", LuBarChart);
}
