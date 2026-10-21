import { parseInlines } from "./chatMdInline";
import {
  MD_MAX_DEPTH,
  MD_MAX_TABLE_COLS,
  MD_MAX_TABLE_ROWS,
  type MdAlign,
  type MdBlock,
  type MdInline,
  type MdState,
  take,
} from "./chatMdTypes";

// ── Markdown blocks: fences, headings, rules, quotes, lists, tables, paragraphs (U8c) ─────────────────

// ── blocks ────────────────────────────────────────────────────────────────────────────────────────

const lead = (l: string): number => {
  let k = 0;
  while (l.charCodeAt(k) === 32) k++;
  return k;
};
const blank = (l: string): boolean => lead(l) === l.length;

function fenceOf(l: string): { ch: string; len: number; indent: number; info: string } | undefined {
  const indent = lead(l);
  const ch = l[indent];
  if (indent > 3 || (ch !== "`" && ch !== "~")) return undefined;
  let k = indent;
  while (l[k] === ch) k++;
  const info = l.slice(k).trim();
  if (k - indent < 3 || (ch === "`" && info.includes("`"))) return undefined;
  return { ch, len: k - indent, indent, info };
}
function headingOf(l: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | undefined {
  const indent = lead(l);
  if (indent > 3) return undefined;
  let k = indent;
  while (l[k] === "#") k++;
  const level = k - indent;
  if (level < 1 || level > 6 || (k < l.length && l[k] !== " ")) return undefined;
  let text = l.slice(k).trim();
  let e = text.length;
  while (e > 0 && text[e - 1] === "#") e--;
  if (e < text.length && (e === 0 || text[e - 1] === " ")) text = text.slice(0, e).trimEnd();
  return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text };
}
function isRule(l: string): boolean {
  if (lead(l) > 3) return false;
  const t = l.trim();
  const ch = t[0];
  if (ch !== "-" && ch !== "*" && ch !== "_") return false;
  let n = 0;
  for (const c of t) {
    if (c === ch) n++;
    else if (c !== " ") return false;
  }
  return n >= 3;
}
function quoteOf(l: string): string | undefined {
  const indent = lead(l);
  if (indent > 3 || l[indent] !== ">") return undefined;
  const rest = l.slice(indent + 1);
  return rest[0] === " " ? rest.slice(1) : rest;
}
interface Marker {
  readonly ordered: boolean;
  readonly start: number;
  readonly ch: string;
  readonly offset: number;
  readonly rest: string;
}
function markerOf(l: string): Marker | undefined {
  const indent = lead(l);
  if (indent > 3 || indent >= l.length) return undefined;
  let k = indent;
  let ordered = false;
  let start = 1;
  let ch = l[k] as string;
  if (ch === "-" || ch === "*" || ch === "+") k++;
  else {
    let d = k;
    while (d < l.length && d - k < 9 && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
    if (d === k || (l[d] !== "." && l[d] !== ")")) return undefined;
    ordered = true;
    start = Number(l.slice(k, d));
    ch = l[d] as string;
    k = d + 1;
  }
  if (k < l.length && l[k] !== " ") return undefined;
  let sp = 0;
  while (l[k + sp] === " ") sp++;
  const empty = k + sp >= l.length;
  const pad = empty || sp > 4 ? 1 : sp;
  return { ordered, start, ch, offset: k + pad, rest: empty ? "" : l.slice(k + pad) };
}
function startsBlock(l: string, nest: boolean): boolean {
  if (fenceOf(l) || headingOf(l) || isRule(l)) return true;
  if (!nest) return false;
  if (quoteOf(l) !== undefined) return true;
  const m = markerOf(l);
  return m !== undefined && m.rest.trim() !== "" && (!m.ordered || m.start === 1);
}

function splitRow(l: string): string[] {
  let t = l.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < t.length; k++) {
    const c = t[k] as string;
    if (c === "\\" && t[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
const DELIM_CELL = /^:?-+:?$/;
function tableAlign(l: string, cols: number): MdAlign[] | undefined {
  if (!l.includes("-")) return undefined;
  const cells = splitRow(l);
  if (cells.length !== cols || !cells.every((c) => DELIM_CELL.test(c))) return undefined;
  return cells.map((c) =>
    c.startsWith(":") ? (c.endsWith(":") ? "center" : "left") : c.endsWith(":") ? "right" : null
  );
}

export function parseBlocks(lines: readonly string[], depth: number, st: MdState): MdBlock[] {
  const out: MdBlock[] = [];
  const nest = depth < MD_MAX_DEPTH;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i] as string;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!take(st)) break;
    const fence = fenceOf(l);
    if (fence) {
      const body: string[] = [];
      for (i++; i < n; i++) {
        const c = lines[i] as string;
        const g = fenceOf(c);
        if (g && g.ch === fence.ch && g.len >= fence.len && g.info === "") {
          i++;
          break;
        }
        body.push(c.slice(Math.min(lead(c), fence.indent)));
      }
      const word = fence.info.split(" ")[0] ?? "";
      out.push({
        type: "code",
        ...(/^[A-Za-z0-9_+#.-]{1,24}$/.test(word) && { lang: word }),
        text: body.join("\n"),
      });
      continue;
    }
    const h = headingOf(l);
    if (h) {
      out.push({ type: "heading", level: h.level, inlines: parseInlines(h.text, st) });
      i++;
      continue;
    }
    if (isRule(l)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    if (nest && quoteOf(l) !== undefined) {
      const inner: string[] = [];
      for (; i < n && quoteOf(lines[i] as string) !== undefined; i++)
        inner.push(quoteOf(lines[i] as string) as string);
      out.push({ type: "quote", blocks: parseBlocks(inner, depth + 1, st) });
      continue;
    }
    const mk = nest ? markerOf(l) : undefined;
    if (mk) {
      const items: MdBlock[][] = [];
      while (i < n) {
        let next = i;
        while (next < n && blank(lines[next] as string)) next++;
        const m = next < n ? markerOf(lines[next] as string) : undefined;
        if (!m || m.ordered !== mk.ordered || m.ch !== mk.ch || isRule(lines[next] as string))
          break;
        i = next;
        const body: string[] = [m.rest];
        for (i++; i < n; i++) {
          const c = lines[i] as string;
          if (blank(c)) {
            let j = i;
            while (j < n && blank(lines[j] as string)) j++;
            if (j < n && lead(lines[j] as string) >= 2) {
              body.push("");
              continue;
            }
            break;
          }
          const ind = lead(c);
          if (ind >= 2) body.push(c.slice(Math.min(ind, m.offset)));
          else if (
            !startsBlock(c, true) &&
            markerOf(c) === undefined &&
            body[body.length - 1] !== ""
          )
            body.push(c);
          else break;
        }
        if (!take(st)) break;
        items.push(parseBlocks(body, depth + 1, st));
      }
      out.push({ type: "list", ordered: mk.ordered, start: mk.start, items });
      continue;
    }
    // a table: a header row, then a delimiter row of the same width
    if (l.includes("|") && i + 1 < n) {
      const head = splitRow(l);
      const align =
        head.length <= MD_MAX_TABLE_COLS
          ? tableAlign(lines[i + 1] as string, head.length)
          : undefined;
      if (align) {
        const rows: MdInline[][][] = [];
        for (
          i += 2;
          i < n && !blank(lines[i] as string) && !startsBlock(lines[i] as string, nest);
          i++
        ) {
          if (rows.length >= MD_MAX_TABLE_ROWS) {
            st.truncated = true;
            continue;
          }
          const cells = splitRow(lines[i] as string);
          rows.push(head.map((_, c) => parseInlines(cells[c] ?? "", st)));
        }
        out.push({ type: "table", align, head: head.map((c) => parseInlines(c, st)), rows });
        continue;
      }
    }
    const para: string[] = [l.trimStart()];
    for (i++; i < n && !blank(lines[i] as string) && !startsBlock(lines[i] as string, nest); i++)
      para.push((lines[i] as string).trimStart());
    out.push({ type: "paragraph", inlines: parseInlines(para.join("\n"), st) });
  }
  return out;
}
