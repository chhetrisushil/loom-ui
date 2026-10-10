import { defineElement } from "../define";
import { LuLocalePicker } from "../widgets/lu-locale-picker";

/** Register `<lu-locale-picker>`. Idempotent. */
export function defineLocalePicker(): void {
  defineElement("lu-locale-picker", LuLocalePicker);
}
