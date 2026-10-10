import { defineElement } from "../define";
import { LuChatMissing } from "../widgets/lu-chat-missing";

/** Register `<lu-chat-missing>`. Idempotent. */
export function defineChatMissing(): void {
  defineElement("lu-chat-missing", LuChatMissing);
}
