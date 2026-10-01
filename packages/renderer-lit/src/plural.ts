// Counted nouns: `n row` / `n rows` in the active locale's plural categories. Kept apart from
// `i18n.ts` so it reaches `t` through the module boundary — the one seam a host (or a test)
// replaces.
import { formattingLocale, t } from "./i18n";

/** The forms of a counted noun: `one` and `other` always, a locale's other categories optionally. */
export type PluralForms = { readonly one: string; readonly other: string } & {
  readonly [C in Exclude<Intl.LDMLPluralRule, "one" | "other">]?: string;
};
const pluralRules = new Map<string, Intl.PluralRules | null>();
function rulesFor(l: string): Intl.PluralRules | null {
  let r = pluralRules.get(l);
  if (r === undefined) {
    try {
      r = new Intl.PluralRules(l);
    } catch {
      r = null; // a tag Intl cannot parse: plain "other"
    }
    pluralRules.set(l, r);
  }
  return r;
}
const EN_RULES = new Intl.PluralRules("en");

/**
 * A counted noun, grammatical in English at all times and in the host's language when it has one.
 *
 * The key is `<key>.<category>`, translated through `t`; `english` is the text used until it is.
 * The ACTIVE locale's plural category (`Intl.PluralRules` — French 0 is `one`, Japanese has only
 * `other`, Russian has one/few/many) selects the form ONLY when `t` returns a translation for that
 * category, i.e. something other than the English fallback. Without one, choosing the category by
 * the locale's rules would pair English words with another language's grammar ("1 rows" under
 * `ja`, "0 row" under `fr`), so the category is chosen by English rules instead.
 */
export function tPlural(key: string, n: number, english: PluralForms): string {
  const category = rulesFor(formattingLocale())?.select(n) ?? "other";
  const fallback = english[category] ?? english.other;
  const localised = t(`${key}.${category}`, fallback);
  if (localised !== fallback) return localised;
  const en = EN_RULES.select(n) === "one" ? "one" : "other";
  return t(`${key}.${en}`, english[en]);
}
