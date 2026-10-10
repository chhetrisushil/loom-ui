import { defineElement } from "../define";
import { LuStatusCard } from "../widgets/lu-status-card";

/** Register `<lu-status-card>`. Idempotent. */
export function defineStatusCard(): void {
  defineElement("lu-status-card", LuStatusCard);
}
