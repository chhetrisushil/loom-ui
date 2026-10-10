import { defineElement } from "../define";
import { LuTimeseries } from "../widgets/lu-timeseries";

/** Register `<lu-timeseries>`. Idempotent. */
export function defineTimeseries(): void {
  defineElement("lu-timeseries", LuTimeseries);
}
