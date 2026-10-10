import { defineElement } from "../define";
import { LuChat } from "../widgets/lu-chat";

/** Register `<lu-chat>`. Idempotent. */
export function defineChat(): void {
  defineElement("lu-chat", LuChat);
}
