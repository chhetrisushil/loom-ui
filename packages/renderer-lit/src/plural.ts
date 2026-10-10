// Counted nouns: `n row` / `n rows` in the active locale's plural categories. Kept apart from
// `i18n.ts` so it reaches `t` through the module boundary — the one seam a host (or a test)
// replaces. The category logic lives once, in `@loom-ui/core`, beside the terminal's use of it.
import { type PluralForms, selectPlural } from "@loom-ui/core/messages";
import { formattingLocale, t } from "./i18n";

export type { PluralForms };

/**
 * A counted noun, grammatical in English at all times and in the host's language when it has one.
 *
 * The key is `<key>.<category>`, translated through `t`; `english` is the text used until it is.
 * See `selectPlural` for why the locale's category applies only to a real translation.
 */
export function tPlural(key: string, n: number, english: PluralForms): string {
  return selectPlural(formattingLocale(), key, n, english, (k, f) => t(k, f));
}
