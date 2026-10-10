import { defineElement } from "../define";
import { LuMediaMissing } from "../widgets/lu-media-missing";

/** Register `<lu-media-missing>`. Idempotent. */
export function defineMediaMissing(): void {
  defineElement("lu-media-missing", LuMediaMissing);
}
