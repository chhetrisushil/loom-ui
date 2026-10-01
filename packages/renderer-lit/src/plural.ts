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
/**
 * A counted noun in the ACTIVE locale's plural category (`Intl.PluralRules` — so French 0 is
 * singular and Russian has one/few/many). The key is `<key>.<category>`, translated through `t`;
 * `english` is the text used until it is (a category it has no form for reads as `other`).
 */
export function tPlural(key: string, n: number, english: PluralForms): string {
  const category = rulesFor(formattingLocale())?.select(n) ?? "other";
  return t(`${key}.${category}`, english[category] ?? english.other);
}
