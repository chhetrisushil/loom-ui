// ── Markdown as plain lines (U8c) ───────────────────────────────────────────────────────────────────
// What a terminal, a speech engine or a log shows for a parsed document: readable plain text, never a control
// sequence. The tree is not trusted (a renderer can be handed a forged one): every string is cleaned again here
// (`stripUnsafeChars`: ESC, C0, C1, bidi and tag characters), a link goes through the shared `mdDestination` check
// (an unsafe one is only its label), a heading level is clamped to 1..6, an unknown or malformed node is nothing,
// and nesting is cut at a fixed depth. Emphasis keeps its `*` marks (there is no bold without styling), a link shows
// its address next to its label (a terminal cannot hide where a link goes; an international host in punycode), a
// reference marker is `[n]`, a table is its own pipe form. No ANSI and no OSC 8 hyperlink is ever produced.

import { mdDestination, mdDisplayAddress } from "./chatMdDest";
import type { MdBlock, MdDoc, MdInline } from "./chatMdTypes";
import { sanitizeChatText } from "./chatText";

export const MD_MAX_LINES = 200;
const MAX_LINE = 2000;
const MAX_NEST = 16;
/** The default total output budget: the most a document can emit however its tree is shaped (200 lines x 2000). */
export const MD_MAX_CHARS = MD_MAX_LINES * MAX_LINE;
/** Nodes one call may visit. A parsed document has at most 2000; a forged tree with shared children stops here. */
const MD_MAX_VISITS = 10000;
/** A link label longer than this is cut, so the address next to it is never pushed off the line. */
const MAX_LABEL = 120;

/** What one call may still spend. Every node visited and every character emitted draws it down; at zero the walk stops. */
interface Budget {
  visits: number;
  chars: number;
  cut: boolean;
}
const alive = (b: Budget): boolean => {
  if (b.visits-- > 0 && b.chars > 0) return true;
  b.cut = true;
  return false;
};
/** `s` cut to `n` units without half a surrogate pair, and the cut paid for. */
const head = (s: string, n: number): string => {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
};
const spend = (b: Budget, s: string): string => {
  const out = head(s, Math.max(0, b.chars));
  if (out.length < s.length) b.cut = true;
  b.chars -= out.length;
  return out;
};

const arr = <T>(x: readonly T[] | undefined): readonly T[] => (Array.isArray(x) ? x : []);

/**
 * One-line safe text, by the rules every surface shares (`sanitizeChatText`: unsafe characters out, a stray U+FE0F out,
 * U+2028/U+2029 a line break), then any line break or tab a space.
 */
const clean = (x: unknown): string =>
  typeof x === "string"
    ? sanitizeChatText(x, Number.MAX_SAFE_INTEGER).replace(/[\t\r\n]/g, " ")
    : "";

const inline = (nodes: readonly MdInline[] | undefined, depth: number, b: Budget): string => {
  if (depth > MAX_NEST) return "";
  return arr(nodes)
    .map((n): string => {
      if (!alive(b)) return "";
      const o = n as {
        type?: unknown;
        text?: unknown;
        children?: readonly MdInline[];
        href?: unknown;
        n?: unknown;
      };
      switch (o?.type) {
        case "text":
          return spend(b, clean(o.text));
        case "code":
          return `\`${spend(b, clean(o.text))}\``;
        case "em":
          return `*${inline(o.children, depth + 1, b)}*`;
        case "strong":
          return `**${inline(o.children, depth + 1, b)}**`;
        case "link": {
          const label = inline(o.children, depth + 1, b);
          const dest = mdDestination(o.href);
          if (dest === undefined) return label;
          const address = spend(b, clean(mdDisplayAddress(dest)));
          return label.trim() === address || label.trim() === ""
            ? address
            : `${label.length > MAX_LABEL ? `${head(label, MAX_LABEL - 1)}…` : label} (${address})`;
        }
        case "br":
          return "\n";
        case "ref":
          return typeof o.n === "number" && Number.isSafeInteger(o.n) && o.n > 0
            ? spend(b, `[${o.n}]`)
            : "";
        default:
          return ""; // an unresolved marker, or a node this file does not know
      }
    })
    .join("");
};

const cell = (nodes: readonly MdInline[] | undefined, depth: number, b: Budget): string =>
  inline(nodes, depth, b).replace(/\n/g, " ").replace(/\|/g, "\\|");

function blockLines(blk: MdBlock, depth: number, b: Budget): string[] {
  if (depth > MAX_NEST || !alive(b)) return [];
  const o = blk as {
    type?: unknown;
    level?: unknown;
    inlines?: readonly MdInline[];
    text?: unknown;
    blocks?: readonly MdBlock[];
    ordered?: unknown;
    start?: unknown;
    items?: readonly (readonly MdBlock[])[];
    head?: readonly (readonly MdInline[])[];
    rows?: readonly (readonly (readonly MdInline[])[])[];
  } | null;
  switch (o?.type) {
    case "paragraph":
      return inline(o.inlines, 0, b).split("\n");
    case "heading": {
      const level =
        typeof o.level === "number" && Number.isInteger(o.level)
          ? Math.min(6, Math.max(1, o.level))
          : 6;
      return [`${"#".repeat(level)} ${inline(o.inlines, 0, b).replace(/\n/g, " ")}`];
    }
    case "code":
      return head(typeof o.text === "string" ? o.text : "", Math.max(0, b.chars) + 1)
        .split(/\r\n?|\n|\u2028|\u2029/)
        .map((l) => `| ${spend(b, clean(l))}`);
    case "quote":
      return blocksLines(arr(o.blocks), depth + 1, b).map((l) => (l === "" ? ">" : `> ${l}`));
    case "list": {
      const first =
        typeof o.start === "number" && Number.isSafeInteger(o.start) && o.start >= 0 ? o.start : 1;
      const out: string[] = [];
      for (const [k, item] of arr(o.items).entries()) {
        const mark = o.ordered === true ? `${first + k}. ` : "- ";
        blocksLines(arr(item), depth + 1, b, false).forEach((l, j) =>
          out.push(j === 0 ? `${mark}${l}` : l === "" ? "" : `${" ".repeat(mark.length)}${l}`)
        );
        if (out.length > MD_MAX_LINES || !alive(b)) break;
      }
      return out;
    }
    case "table": {
      const row = (cells: readonly (readonly MdInline[])[]): string =>
        `| ${arr(cells)
          .map((c) => (alive(b) ? cell(c, 0, b) : ""))
          .join(" | ")} |`;
      const head = arr(o.head);
      return [
        row(head),
        `| ${head.map(() => "---").join(" | ")} |`,
        ...arr(o.rows)
          .slice(0, MD_MAX_LINES + 1)
          .map(row),
      ];
    }
    case "rule":
      return ["---"];
    default:
      return [];
  }
}
function blocksLines(
  blocks: readonly MdBlock[],
  depth: number,
  b: Budget,
  spaced = true
): string[] {
  const out: string[] = [];
  for (const blk of blocks) {
    const lines = blockLines(blk, depth, b);
    if (lines.length === 0) continue;
    if (spaced && out.length > 0) out.push("");
    out.push(...lines);
    if (out.length > MD_MAX_LINES || b.chars <= 0 || b.visits <= 0) break;
  }
  return out;
}

const cut = (l: string): string => (l.length <= MAX_LINE ? l : `${head(l, MAX_LINE - 1)}…`);

/**
 * The document as plain lines: at most {@link MD_MAX_LINES} (then `…`), each at most 2000 characters, none with a control
 * character, and in total at most `maxChars` (default {@link MD_MAX_CHARS}) characters from at most 10000 visited nodes
 * whatever the tree's shape (a forged tree with shared children cannot blow up); a cut by any bound ends in `…`.
 */
export function chatMarkdownLines(doc: MdDoc, options: { maxChars?: number } = {}): string[] {
  const b: Budget = {
    visits: MD_MAX_VISITS,
    chars: Math.min(MD_MAX_CHARS, Math.max(0, options.maxChars ?? MD_MAX_CHARS)),
    cut: false,
  };
  const all = blocksLines(arr(doc?.blocks), 0, b);
  const over = all.length > MD_MAX_LINES;
  const lines = (over ? all.slice(0, MD_MAX_LINES) : all).map(cut);
  return over || b.cut || doc?.truncated === true ? [...lines, "…"] : lines;
}
