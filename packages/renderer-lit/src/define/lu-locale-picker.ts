import { defineElement } from "../define.js";
import { LuLocalePicker } from "../widgets/lu-locale-picker.js";

/** Register `<lu-locale-picker>`. Idempotent. */
export function defineLocalePicker(): void {
  defineElement("lu-locale-picker", LuLocalePicker);
}
