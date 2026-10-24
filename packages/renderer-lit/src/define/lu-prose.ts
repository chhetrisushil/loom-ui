import { defineElement } from "../define";
import { LuProse } from "../widgets/lu-prose";

/** Register `<lu-prose>`. Idempotent. */
export function defineProse(): void {
  defineElement("lu-prose", LuProse);
}
