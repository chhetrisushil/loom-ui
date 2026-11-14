import { defineElement } from "../define.js";
import { LuTimeRangePicker } from "../widgets/lu-time-range-picker.js";

/** Register `<lu-time-range-picker>`. Idempotent. */
export function defineTimeRangePicker(): void {
  defineElement("lu-time-range-picker", LuTimeRangePicker);
}
