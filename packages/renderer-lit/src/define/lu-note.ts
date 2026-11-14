import { defineElement } from "../define.js";
import { LuNote } from "../widgets/lu-note.js";

/** Register `<lu-note>`. Idempotent. */
export function defineNote(): void {
  defineElement("lu-note", LuNote);
}
