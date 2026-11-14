import { defineElement } from "../define.js";
import { LuBarChart } from "../widgets/lu-bar-chart.js";

/** Register `<lu-bar-chart>`. Idempotent. */
export function defineBarChart(): void {
  defineElement("lu-bar-chart", LuBarChart);
}
