import { defineElement } from "../define.js";
import { LuProse } from "../widgets/lu-prose.js";

/** Register `<lu-prose>`. Idempotent. */
export function defineProse(): void {
  defineElement("lu-prose", LuProse);
}
