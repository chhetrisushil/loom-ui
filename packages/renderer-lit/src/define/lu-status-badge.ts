import { defineElement } from "../define.js";
import { LuStatusBadge } from "../widgets/lu-status-badge.js";

/** Register `<lu-status-badge>`. Idempotent. */
export function defineStatusBadge(): void {
  defineElement("lu-status-badge", LuStatusBadge);
}
