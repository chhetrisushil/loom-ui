import { defineElement } from "../define.js";
import { LuChatMissing } from "../widgets/lu-chat-missing.js";

/** Register `<lu-chat-missing>`. Idempotent. */
export function defineChatMissing(): void {
  defineElement("lu-chat-missing", LuChatMissing);
}
