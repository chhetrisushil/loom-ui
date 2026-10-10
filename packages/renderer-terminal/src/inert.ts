import { stripUnsafeChars } from "@loom-ui/core/chat-ui";

/**
 * Make text inert for a terminal: core's ONE unsafe set (`stripUnsafeChars` — the same class
 * `sanitizeChatText` removes: C0/C1 controls incl. ESC and NUL, bidi overrides/isolates, zero-width
 * and invisible marks, soft hyphen, TAG characters), plus tab, carriage return and the Unicode line
 * separators. Newline is the only control kept: it is the frame's own line structure.
 *
 * It STRIPS; it does not parse. The bytes after a stripped ESC are ordinary printable text, so
 * `ESC ]8;;http://x BEL` leaves a harmless visible `]8;;http://x`. Idempotent; printable text is
 * never touched.
 */
export const inert = (text: string): string =>
  stripUnsafeChars(text).replace(/[\t\r\u{2028}\u{2029}]/gu, "");
