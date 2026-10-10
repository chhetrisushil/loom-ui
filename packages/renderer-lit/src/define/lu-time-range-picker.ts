import { defineElement } from "../define";
import { LuTimeRangePicker } from "../widgets/lu-time-range-picker";

/** Register `<lu-time-range-picker>`. Idempotent. */
export function defineTimeRangePicker(): void {
  defineElement("lu-time-range-picker", LuTimeRangePicker);
}
