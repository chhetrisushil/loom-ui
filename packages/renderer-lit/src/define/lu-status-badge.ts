import { defineElement } from "../define";
import { LuStatusBadge } from "../widgets/lu-status-badge";

/** Register `<lu-status-badge>`. Idempotent. */
export function defineStatusBadge(): void {
  defineElement("lu-status-badge", LuStatusBadge);
}
