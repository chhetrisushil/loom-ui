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
import { stripUnsafeChars } from "./chatText";

export const MD_MAX_LINES = 200;
const MAX_LINE = 2000;
const MAX_NEST = 16;

const arr = <T>(x: readonly T[] | undefined): readonly T[] => (Array.isArray(x) ? x : []);

/** One-line safe text: unsafe characters out, any line break or tab a space. */
const clean = (x: unknown): string =>
  typeof x === "string" ? stripUnsafeChars(x).replace(/[\t\r\n]/g, " ") : "";

const inline = (nodes: readonly MdInline[] | undefined, depth: number): string => {
  if (depth > MAX_NEST) return "";
  return arr(nodes)
    .map((n): string => {
      const o = n as {
        type?: unknown;
        text?: unknown;
        children?: readonly MdInline[];
        href?: unknown;
        n?: unknown;
      };
      switch (o?.type) {
        case "text":
          return clean(o.text);
        case "code":
          return `\`${clean(o.text)}\``;
        case "em":
          return `*${inline(o.children, depth + 1)}*`;
        case "strong":
          return `**${inline(o.children, depth + 1)}**`;
        case "link": {
          const label = inline(o.children, depth + 1);
          const dest = mdDestination(o.href);
          if (dest === undefined) return label;
          const address = clean(mdDisplayAddress(dest));
          return label.trim() === address || label.trim() === ""
            ? address
            : `${label} (${address})`;
        }
        case "br":
          return "\n";
        case "ref":
          return typeof o.n === "number" && Number.isSafeInteger(o.n) && o.n > 0 ? `[${o.n}]` : "";
        default:
          return ""; // an unresolved marker, or a node this file does not know
      }
    })
    .join("");
};

const cell = (nodes: readonly MdInline[] | undefined, depth: number): string =>
  inline(nodes, depth).replace(/\n/g, " ").replace(/\|/g, "\\|");

function blockLines(b: MdBlock, depth: number): string[] {
  if (depth > MAX_NEST) return [];
  const o = b as {
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
      return inline(o.inlines, 0).split("\n");
    case "heading": {
      const level =
        typeof o.level === "number" && Number.isInteger(o.level)
          ? Math.min(6, Math.max(1, o.level))
          : 6;
      return [`${"#".repeat(level)} ${inline(o.inlines, 0).replace(/\n/g, " ")}`];
    }
    case "code":
      return (typeof o.text === "string" ? o.text : "")
        .split(/\r\n?|\n|\u2028|\u2029/)
        .map((l) => `| ${clean(l)}`);
    case "quote":
      return blocksLines(arr(o.blocks), depth + 1).map((l) => (l === "" ? ">" : `> ${l}`));
    case "list": {
      const first =
        typeof o.start === "number" && Number.isSafeInteger(o.start) && o.start >= 0 ? o.start : 1;
      const out: string[] = [];
      for (const [k, item] of arr(o.items).entries()) {
        const mark = o.ordered === true ? `${first + k}. ` : "- ";
        blocksLines(arr(item), depth + 1, false).forEach((l, j) =>
          out.push(j === 0 ? `${mark}${l}` : l === "" ? "" : `${" ".repeat(mark.length)}${l}`)
        );
        if (out.length > MD_MAX_LINES) break;
      }
      return out;
    }
    case "table": {
      const row = (cells: readonly (readonly MdInline[])[]): string =>
        `| ${arr(cells)
          .map((c) => cell(c, 0))
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
function blocksLines(blocks: readonly MdBlock[], depth: number, spaced = true): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const lines = blockLines(b, depth);
    if (lines.length === 0) continue;
    if (spaced && out.length > 0) out.push("");
    out.push(...lines);
    if (out.length > MD_MAX_LINES) break;
  }
  return out;
}

const cut = (l: string): string => {
  if (l.length <= MAX_LINE) return l;
  const end = l.charCodeAt(MAX_LINE - 2);
  // do not leave half a surrogate pair before the ellipsis
  return `${l.slice(0, end >= 0xd800 && end <= 0xdbff ? MAX_LINE - 2 : MAX_LINE - 1)}…`;
};

/** The document as plain lines: at most {@link MD_MAX_LINES} (then `…`), each at most 2000 characters, none with a control character. */
export function chatMarkdownLines(doc: MdDoc): string[] {
  const all = blocksLines(arr(doc?.blocks), 0);
  const over = all.length > MD_MAX_LINES;
  const lines = (over ? all.slice(0, MD_MAX_LINES) : all).map(cut);
  return over || doc?.truncated === true ? [...lines, "…"] : lines;
}
