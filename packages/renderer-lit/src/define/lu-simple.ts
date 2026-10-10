import { defineElement } from "../define";
import { LuAlert, LuApproval, LuList, LuProgress, LuText } from "../widgets/lu-simple";

/** Register `<lu-progress>`, `<lu-alert>`, `<lu-text>`, `<lu-list>`, `<lu-approval>`. Idempotent. */
export function defineSimple(): void {
  defineElement("lu-progress", LuProgress);
  defineElement("lu-alert", LuAlert);
  defineElement("lu-text", LuText);
  defineElement("lu-list", LuList);
  defineElement("lu-approval", LuApproval);
}
