import { useChatContracts } from "@loomwork/ui-core/browser";
import { defineElement } from "../define.js";
import { LuChat } from "../widgets/lu-chat.js";

/** Register `<lu-chat>`. Idempotent. */
export function defineChat(): void {
  // the value contracts these widgets check are deferred in core: load them first
  useChatContracts();
  defineElement("lu-chat", LuChat);
}
