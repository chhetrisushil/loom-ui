// ── Markdown in a chat transcript (U8c) ───────────────────────────────────────────────────────────
//
// A text part MAY say `format: "markdown"`. The text is still UNTRUSTED. This module is the whole of what
// that opt-in means: a hand-written parser for a FIXED, CLOSED subset of CommonMark/GFM that produces a
// small, bounded AST ({@link MdDoc}); renderers build their own nodes from the AST. Nothing here produces
// HTML, and the AST is never carried in a value (a source cannot forge a `link` node): every renderer parses
// the sanitised text itself.
//
//  IN:  paragraphs, ATX headings, emphasis and strong, inline code, fenced code blocks, ordered and bullet lists,
//       blockquotes, thematic breaks, GFM tables, `[label](url)` links, hard breaks, `[[id]]` reference markers.
//  OUT: raw HTML (`<b>` is text), entities (`&amp;` is text), images (the alt text is shown; an image address is the classic
//       exfiltration channel), autolinks and bare URLs (never linked), reference-style links, setext headings, indented
//       code, footnotes, strikethrough, task lists. Backslash escapes work for ASCII punctuation.
//  LINKS: only `http:`, `https:` and `mailto:`, no whitespace or control character, no userinfo (`https://a@b`), at most 2048
//       characters. A link that fails the rule is dropped and its label stays as text.
//  BOUNDS: {@link MD_MAX_NODES} nodes in all (the rest is cut and `truncated` is set), blocks nest at most
//       {@link MD_MAX_DEPTH} deep (deeper container syntax is plain text), inline nesting at most
//       {@link MD_MAX_INLINE_DEPTH}, at most 200 emphasis delimiter runs per inline run (more are literal), tables at most
//       {@link MD_MAX_TABLE_COLS} columns and {@link MD_MAX_TABLE_ROWS} rows. Every scan is a single pass or a
//       pre-indexed lookup, so the cost is linear in the (cut) input; `chatMarkdown.test.ts` pins absolute bounds on
//       adversarial input. Total: it never throws.
//  STREAMING: parsing is a pure function of the text so far, so a half-written reply is just a shorter text. The
//       CommonMark rules already settle it (an unclosed fence runs to the end, an unmatched `*` is a literal `*`); with
//       `streaming: true` a trailing half-written `[[id`, and a half-written `[label](ur`, are not drawn at all.

import { parseBlocks } from "./chatMdBlock";
import type { ChatMarkdownOptions, MdDoc, MdState } from "./chatMdTypes";
import { sanitizeChatText } from "./chatText";

export {
  MD_MAX_DEPTH,
  MD_MAX_INLINE_DEPTH,
  MD_MAX_NODES,
  MD_MAX_TABLE_COLS,
  MD_MAX_TABLE_ROWS,
  MD_MAX_URL,
  mdPlainText,
  safeLinkHref,
} from "./chatMdTypes";
export type { ChatMarkdownOptions, MdAlign, MdBlock, MdDoc, MdInline } from "./chatMdTypes";

/**
 * Parse untrusted `text` as the markdown subset above. The text is cleaned first (`sanitizeChatText`: controls, bidi,
 * TAG characters, vertical-space bombs, the {@link MAX_CHAT_TEXT} cut), so every string in the AST is already safe to draw.
 * Total, linear, never throws.
 */
export function parseChatMarkdown(text: unknown, options: ChatMarkdownOptions = {}): MdDoc {
  return parseChatMarkdownMetered(text, options);
}

/** {@link parseChatMarkdown} with a work counter, for tests that pin a step bound instead of a time. Not part of the public entry. */
export function parseChatMarkdownMetered(
  text: unknown,
  options: ChatMarkdownOptions = {},
  meter?: { steps: number }
): MdDoc {
  const st: MdState = {
    nodes: 0,
    truncated: false,
    markers: options.markers === true,
    streaming: options.streaming === true,
    ...(meter && { meter }),
  };
  const clean = sanitizeChatText(text).replace(/\t/g, "    ");
  const blocks = parseBlocks(clean.split("\n"), 0, st);
  return { blocks, truncated: st.truncated };
}
