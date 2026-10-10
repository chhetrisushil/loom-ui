import { defineElement } from "../define";
import { LuNote } from "../widgets/lu-note";

/** Register `<lu-note>`. Idempotent. */
export function defineNote(): void {
  defineElement("lu-note", LuNote);
}
