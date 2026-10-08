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
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u00ad\u115f\u1160\u2060-\u2069\u3164\ufe00-\ufe0e\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// VS16 (emoji presentation) is kept only after a symbol or emoji; after an ASCII character it is an
// invisible mark with nothing to select (and VS1-15 / the supplement select glyphs invisibly: removed above).
const STRAY_VS16 = /(?<![\u2000-\u{10ffff}])\ufe0f/gu;
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
    .replace(STRAY_VS16, "")
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
