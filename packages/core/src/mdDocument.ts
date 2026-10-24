// ── Markdown documents ──────────────────────────────────────────────────────────────────────────────
//
// The document profile of `parseChatMarkdown`: the SAME closed subset, block and inline parsers, link rule and
// AST (so `drawMarkdown` draws it unchanged), for a whole stored document rather than a chat reply. It differs in
// three ways: larger bounds ({@link MD_DOC_MAX_TEXT} characters, {@link MD_DOC_MAX_NODES} nodes, then `truncated`);
// unsafe characters are stripped per line but blank runs are NOT folded and nothing is cut mid-line, so line
// offsets stay exact; and every top-level block carries its source range, so a caller can find the block that
// holds a given character offset (a cited passage). Total, linear, never throws.

import { parseBlocks } from "./chatMdBlock";
import type { MdDoc, MdState } from "./chatMdTypes";
import { stripUnsafeChars } from "./chatText";

export const MD_DOC_MAX_TEXT = 1_048_576;
export const MD_DOC_MAX_NODES = 100_000;
export const MD_DOC_MAX_TABLE_ROWS = 1_000;

/** A range of UTF-16 offsets into the parsed input; `to` is exclusive. */
export interface MdRange {
  readonly from: number;
  readonly to: number;
}

/** An {@link MdDoc} whose `ranges[i]` is the source range of `blocks[i]`. */
export interface MdDocument extends MdDoc {
  readonly ranges: readonly MdRange[];
}

/**
 * The input as lines for a block parser: `lines` cleaned (unsafe characters stripped, a trailing `\r` dropped,
 * tabs as four spaces), `raw` and `starts` as they were in the input, so a line index maps back to offsets.
 * Over {@link MD_DOC_MAX_TEXT} the text is cut at the last line break before the bound.
 */
export function documentLines(text: string): {
  lines: string[];
  starts: number[];
  raw: string[];
  truncated: boolean;
} {
  let body = text;
  let truncated = false;
  if (body.length > MD_DOC_MAX_TEXT) {
    const cut = body.lastIndexOf("\n", MD_DOC_MAX_TEXT);
    body = body.slice(0, cut > 0 ? cut : MD_DOC_MAX_TEXT);
    truncated = true;
  }
  const raw = body.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const r of raw) {
    starts.push(at);
    at += r.length + 1;
  }
  const lines = raw.map((r) =>
    stripUnsafeChars(r.endsWith("\r") ? r.slice(0, -1) : r).replace(/\t/g, "    ")
  );
  return { lines, starts, raw, truncated };
}

/** Line spans to source ranges; a range never includes a line's trailing `\r`. */
export function spansToRanges(
  spans: readonly { line: number; end: number }[],
  starts: readonly number[],
  raw: readonly string[]
): MdRange[] {
  return spans.map(({ line, end }) => {
    const last = raw[end - 1] ?? "";
    const trim = last.endsWith("\r") ? 1 : 0;
    return { from: starts[line] ?? 0, to: (starts[end - 1] ?? 0) + last.length - trim };
  });
}

/** Parse untrusted `text` as a whole markdown document (see the header). Non-strings are an empty document. */
export function parseMarkdownDocument(text: unknown): MdDocument {
  return parseMarkdownDocumentWith(text, undefined);
}

/** {@link parseMarkdownDocument} with a work meter; for the bounds tests only. */
export function parseMarkdownDocumentWith(
  text: unknown,
  meter: { steps: number } | undefined
): MdDocument {
  if (typeof text !== "string") return { blocks: [], ranges: [], truncated: false };
  const { lines, starts, raw, truncated } = documentLines(text);
  const spans: { line: number; end: number }[] = [];
  const st: MdState = {
    nodes: 0,
    truncated,
    markers: false,
    streaming: false,
    maxNodes: MD_DOC_MAX_NODES,
    maxTableRows: MD_DOC_MAX_TABLE_ROWS,
    spans,
    ...(meter && { meter }),
  };
  const blocks = parseBlocks(lines, 0, st);
  return { blocks, ranges: spansToRanges(spans, starts, raw), truncated: st.truncated };
}
