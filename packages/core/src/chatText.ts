// ── Untrusted chat text (U8) ────────────────────────────────────────────────────────────────────
//
// Everything a person typed, and everything a model or tool said about it, is UNTRUSTED text
// (loom ADR 0085, ADR 0122 D6). It is drawn as TEXT, always: no renderer in this repository turns
// chat text into markup, and none auto-links it. What this module adds is the part markup escaping
// cannot do: it removes the characters that change what a reader SEES or what a terminal DOES.
//
//  - C0/C1 controls (a terminal's escape sequences begin with ESC), except newline and tab;
//  - Hangul fillers, the soft hyphen and variation selectors (invisible glyphs that make a blank-looking name);
//  - bidirectional overrides and isolates and the zero-width marks that reorder or hide text
//    (a Trojan-source line: `user\u202e txet`), except ZWJ/ZWNJ, which emoji and several scripts need;
//  - Unicode TAG characters (U+E0000-E007F): invisible, and the carrier of "ASCII smuggling";
//  - CR / U+2028 / U+2029 become `\n`; three or more newlines collapse to two (a vertical-space bomb).
//
// Every pass is a single character-class scan or a fixed-string loop: LINEAR in the input, no
// nested quantifier, no backtracking. The input is cut BEFORE it is scanned, so a 10 MB string
// costs the cut, not the scan. `chatText.test.ts` pins absolute bounds on 100 KB adversarial input.

import { MAX_CHAT_TEXT } from "./chatValue";

const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: the class lists the invisible code points to REMOVE, each on its own
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u00ad\u115f\u1160\u2060-\u2069\u3164\ufe00-\ufe0e\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// VS16 (U+FE0F, emoji presentation) is kept ONLY where it selects something: directly after a
// pictographic character, or between a keycap base (`#`, `*`, a digit) and U+20E3. Everywhere else
// (after text, whitespace, a line break, another VS16) it is an invisible mark that carries nothing but
// a side channel, and a run of them is a way to smuggle bytes behind one emoji. The decision looks only
// at the character before (and for a keycap, the one after), so the pass is linear, and applying it to
// its own output changes nothing (a kept VS16 still has its pictograph before it).
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const STRAY_VS16 = /\ufe0f/g;
function keepsVs16(whole: string, at: number): boolean {
  if (at === 0) return false;
  const lo = whole.charCodeAt(at - 1);
  const before =
    lo >= 0xdc00 && lo <= 0xdfff && at >= 2 ? whole.slice(at - 2, at) : whole.slice(at - 1, at);
  if (PICTOGRAPHIC.test(before)) return true;
  return /^[#*0-9]$/.test(before) && whole.charCodeAt(at + 1) === 0x20e3;
}
const LINE_BREAKS = /\r\n?|\u2028|\u2029/g;
const BLANK_RUNS = /\n{3,}/g;

/**
 * `text` made safe to DRAW: untrusted text in, text out. Not a sanitiser for HTML (nothing here
 * produces HTML) and not a filter for meaning. Bounded to `max` UTF-16 units (a cut ends in `…`).
 * Non-strings become `""`. Total, linear, never throws.
 */
export function sanitizeChatText(text: unknown, max: number = MAX_CHAT_TEXT): string {
  if (typeof text !== "string") return "";
  // Cut first: the scan below is linear, but there is no reason to pay it for bytes we will drop.
  // The cut leaves room for the removed characters (up to 2x for controls turned newlines) by
  // scanning at most 2 * max and re-cutting.
  const limit = Math.max(0, max);
  const head = text.length > limit * 2 ? text.slice(0, limit * 2) : text;
  const clean = head
    .replace(UNSAFE, "")
    .replace(STRAY_VS16, (m, at: number, whole: string) => (keepsVs16(whole, at) ? m : ""))
    .replace(LINE_BREAKS, "\n")
    .replace(BLANK_RUNS, "\n\n");
  if (head.length === text.length && clean.length <= limit) return clean;
  let cut = clean.slice(0, Math.max(0, limit - 1));
  // Never end on half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** One line of untrusted text (labels, a terminal row): newlines and tabs become a space, runs of space collapse. */
export function oneLineChatText(text: unknown, max = 200): string {
  const clean = sanitizeChatText(text, max * 2)
    .replace(/[\n\t]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
