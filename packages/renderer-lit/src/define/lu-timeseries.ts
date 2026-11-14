import { defineElement } from "../define.js";
import { LuTimeseries } from "../widgets/lu-timeseries.js";

/** Register `<lu-timeseries>`. Idempotent. */
export function defineTimeseries(): void {
  defineElement("lu-timeseries", LuTimeseries);
}
