// ── Org documents ────────────────────────────────────────────────────────────────────────────────────
//
// A hand-written parser for a CLOSED subset of Org, emitted as the markdown AST so the hardened markdown renderers draw
// it unchanged, with the same document bounds and per-block source ranges as `parseMarkdownDocument`. Not `orga`:
// that is not hardened for untrusted input and would be a dependency of core. The subset (anything else is a paragraph):
// headlines (1-6; TODO keyword, [#P] priority and :tags: dropped), #+TITLE (level 1), other #+KEYWORD lines and
// "# " comments (dropped), :DRAWER: ... :END: and SCHEDULED/DEADLINE/CLOSED lines (dropped), - + 1. 1) lists,
// #+BEGIN_SRC/EXAMPLE (code), #+BEGIN_QUOTE (quote), | tables with a |---+---| head rule, and 5+ dashes (rule).
// Total, linear, never throws.

import {
  MD_MAX_DEPTH,
  MD_MAX_TABLE_COLS,
  type MdBlock,
  type MdInline,
  type MdState,
  take,
  work,
} from "./chatMdTypes";
import {
  MD_DOC_MAX_NODES,
  MD_DOC_MAX_TABLE_ROWS,
  type MdDocument,
  documentLines,
  spansToRanges,
} from "./mdDocument";
import { parseOrgInlines } from "./orgInline";

const HEADLINE = /^(\*+)\s+(.*)$/;
const TODO = /^(?:TODO|DONE|NEXT|WAITING|HOLD|CANCELLED|CANCELED)\s+/;
const PRIORITY = /^\[#[A-Za-z0-9]\]\s*/;
const TAGS = /\s+:[\w@#%:]+:\s*$/;
const KEYWORD = /^\s*#\+(\w+):\s*(.*)$/;
const BEGIN = /^\s*#\+begin_(\w+)(?:\s+(\S+))?/i;
const DRAWER = /^\s*:[\w-]+:\s*$/;
const PLANNING = /^\s*(?:SCHEDULED|DEADLINE|CLOSED):/;
const ITEM = /^(\s*)(?:([-+])|(\d{1,9})[.)])\s+(.*)$/;
const RULE = /^\s*-{5,}\s*$/;
const TABLE = /^\s*\|/;
const TABLE_RULE = /^\s*\|-[-+|]*\s*$/;

const blank = (l: string) => l.trim() === "";
const startsBlock = (l: string) =>
  HEADLINE.test(l) ||
  KEYWORD.test(l) ||
  BEGIN.test(l) ||
  ITEM.test(l) ||
  RULE.test(l) ||
  TABLE.test(l) ||
  DRAWER.test(l) ||
  /^\s*# /.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parseOrgBlocks(lines: readonly string[], depth: number, st: MdState): MdBlock[] {
  const out: MdBlock[] = [];
  const spans = depth === 0 ? st.spans : undefined;
  const inl = (s: string): MdInline[] => parseOrgInlines(s, st);
  const n = lines.length;
  let i = 0;
  let open: { line: number; count: number } | undefined;
  const flush = (): void => {
    if (spans && open && out.length > open.count) spans.push({ line: open.line, end: i });
    open = undefined;
  };
  while (i < n) {
    flush();
    work(st);
    const l = lines[i] as string;
    if (blank(l) || /^\s*# /.test(l) || l.trim() === "#" || PLANNING.test(l)) {
      i++;
      continue;
    }
    if (DRAWER.test(l) && !/^\s*:END:\s*$/i.test(l)) {
      let j = i + 1;
      while (j < n && !/^\s*:END:\s*$/i.test(lines[j] as string)) {
        work(st);
        j++;
      }
      i = j < n ? j + 1 : i + 1; // an unclosed drawer is just a line
      continue;
    }
    if (!take(st)) break;
    if (spans) open = { line: i, count: out.length };
    const h = HEADLINE.exec(l);
    if (h) {
      const title = (h[2] as string).replace(TODO, "").replace(PRIORITY, "").replace(TAGS, "");
      out.push({
        type: "heading",
        level: Math.min((h[1] as string).length, 6) as 1 | 2 | 3 | 4 | 5 | 6,
        inlines: inl(title),
      });
      i++;
      continue;
    }
    const b = BEGIN.exec(l);
    if (b) {
      const kind = (b[1] as string).toLowerCase();
      const end = new RegExp(`^\\s*#\\+end_${kind}\\b`, "i");
      const body: string[] = [];
      for (i++; i < n && !end.test(lines[i] as string); i++) {
        work(st);
        body.push(lines[i] as string);
      }
      if (i < n) i++; // past #+END_ (an unclosed block runs to the end)
      if (kind === "quote" && depth < MD_MAX_DEPTH)
        out.push({ type: "quote", blocks: parseOrgBlocks(body, depth + 1, st) });
      else {
        const lang =
          kind === "src" && b[2] && /^[A-Za-z0-9_+#.-]{1,24}$/.test(b[2]) ? b[2] : undefined;
        out.push({ type: "code", ...(lang && { lang }), text: body.join("\n") });
      }
      continue;
    }
    const k = KEYWORD.exec(l);
    if (k) {
      if ((k[1] as string).toLowerCase() === "title")
        out.push({ type: "heading", level: 1, inlines: inl(k[2] as string) });
      i++;
      continue;
    }
    if (RULE.test(l)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    if (TABLE.test(l)) {
      const rowsRaw: string[] = [];
      let ruleAt = -1;
      for (; i < n && TABLE.test(lines[i] as string); i++) {
        work(st);
        if (TABLE_RULE.test(lines[i] as string)) {
          if (ruleAt === -1) ruleAt = rowsRaw.length;
        } else rowsRaw.push(lines[i] as string);
      }
      let width = 1;
      for (const r of rowsRaw) width = Math.max(width, cells(r).length);
      width = Math.min(width, MD_MAX_TABLE_COLS);
      const row = (r: string) => {
        const cs = cells(r);
        return Array.from({ length: width }, (_, c) => (take(st) ? inl(cs[c] ?? "") : []));
      };
      const headed = ruleAt === 1;
      const head = headed
        ? row(rowsRaw[0] as string)
        : Array.from({ length: width }, () => [] as MdInline[]);
      const body = (headed ? rowsRaw.slice(1) : rowsRaw).slice(
        0,
        st.maxTableRows ?? MD_DOC_MAX_TABLE_ROWS
      );
      if (body.length < (headed ? rowsRaw.length - 1 : rowsRaw.length)) st.truncated = true;
      out.push({
        type: "table",
        align: Array.from({ length: width }, () => null),
        head,
        rows: body.map(row),
      });
      continue;
    }
    const it = ITEM.exec(l);
    if (it && depth < MD_MAX_DEPTH) {
      const ordered = it[3] !== undefined;
      const start = ordered ? Number(it[3]) : 1;
      const indent = (it[1] as string).length;
      const items: MdBlock[][] = [];
      while (i < n) {
        const m = ITEM.exec(lines[i] as string);
        if (!m || (m[1] as string).length !== indent || (m[3] !== undefined) !== ordered) break;
        const body: string[] = [m[4] as string];
        for (i++; i < n; i++) {
          work(st);
          const c = lines[i] as string;
          if (blank(c)) break;
          const ind = c.length - c.trimStart().length;
          if (ind <= indent) break;
          body.push(c.slice(Math.min(ind, indent + 2)));
        }
        if (!take(st)) break;
        items.push(parseOrgBlocks(body, depth + 1, st));
        // blank lines between items stay in the list only when the next item continues it
        let j = i;
        while (j < n && blank(lines[j] as string)) j++;
        const nx = j > i && j < n ? ITEM.exec(lines[j] as string) : null;
        if (nx && (nx[1] as string).length === indent && (nx[3] !== undefined) === ordered) i = j;
      }
      out.push({ type: "list", ordered, start, items });
      continue;
    }
    const para: string[] = [l.trimStart()];
    for (i++; i < n && !blank(lines[i] as string) && !startsBlock(lines[i] as string); i++)
      para.push((lines[i] as string).trimStart());
    out.push({ type: "paragraph", inlines: inl(para.join("\n")) });
  }
  flush();
  return out;
}

export function parseOrgDocument(text: unknown): MdDocument {
  return parseOrgDocumentWith(text, undefined);
}

/** {@link parseOrgDocument} with a work meter; for the bounds tests only. */
export function parseOrgDocumentWith(
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
  const blocks = parseOrgBlocks(lines, 0, st);
  return { blocks, ranges: spansToRanges(spans, starts, raw), truncated: st.truncated };
}
