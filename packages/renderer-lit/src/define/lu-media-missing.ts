import { defineElement } from "../define.js";
import { LuMediaMissing } from "../widgets/lu-media-missing.js";

/** Register `<lu-media-missing>`. Idempotent. */
export function defineMediaMissing(): void {
  defineElement("lu-media-missing", LuMediaMissing);
}
