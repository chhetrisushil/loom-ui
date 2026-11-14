import { defineElement } from "../define.js";
import { LuStatusCard } from "../widgets/lu-status-card.js";

/** Register `<lu-status-card>`. Idempotent. */
export function defineStatusCard(): void {
  defineElement("lu-status-card", LuStatusCard);
}
