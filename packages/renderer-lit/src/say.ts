// The widgets' one way to a fixed string: ask for a catalogue KEY, get the host's text or the English
// default. A separate module from `i18n.ts` so it reaches `t` through the module boundary — the seam a
// host (or a test) replaces.
import { LU_MESSAGES, type LuMessageKey, type LuMessageVars, fill } from "@loom-ui/core/messages";
import { t } from "./i18n";

/** A StatusCard level's word key. */
export const LEVEL_KEY = {
  ok: "lu.level.ok",
  warning: "lu.level.warning",
  critical: "lu.level.critical",
} as const satisfies Record<string, LuMessageKey>;

export function say(key: LuMessageKey, vars?: LuMessageVars): string {
  return fill(t(key, LU_MESSAGES[key]), vars);
}
