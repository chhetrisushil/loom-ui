import { defineElement } from "../define.js";
import { LuChat } from "../widgets/lu-chat.js";

/** Register `<lu-chat>`. Idempotent. */
export function defineChat(): void {
  defineElement("lu-chat", LuChat);
}
