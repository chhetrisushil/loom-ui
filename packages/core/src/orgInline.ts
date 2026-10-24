// ── Org inline markup ────────────────────────────────────────────────────────────────────────────────
//
// A closed subset, emitted as the markdown AST: *bold* -> strong, /italic/ -> em (both nest), =verbatim= and
// ~code~ -> code; [[url][label]] and [[url]] -> link when `safeLinkHref` accepts the url, else the label as text.
// _underline_ and +strike+ stay text. A marker opens only at the start or after whitespace or one of -({'" and
// closes only before the end, whitespace or punctuation; its content may not start or end with whitespace.
// Closers are pre-indexed per marker (one forward pointer each), so the scan is linear in the input.

import {
  MD_MAX_INLINE_DEPTH,
  type MdInline,
  type MdState,
  safeLinkHref,
  take,
  work,
} from "./chatMdTypes";

const MARKERS = "*/=~";
const PRE = /[\s\-({'"]/;
const POST = /[\s\-.,:!?;'")}\[]/;

function closersOf(s: string): Map<string, number[]> {
  const at = new Map<string, number[]>(Array.from(MARKERS, (m) => [m, []]));
  for (let i = 1; i < s.length; i++) {
    const c = s[i] as string;
    const list = at.get(c);
    if (
      list &&
      !/\s/.test(s[i - 1] as string) &&
      (i + 1 === s.length || POST.test(s[i + 1] as string))
    )
      list.push(i);
  }
  return at;
}

export function parseOrgInlines(source: string, st: MdState): MdInline[] {
  const closers = closersOf(source);
  const ends: number[] = [];
  for (let at = source.indexOf("]]"); at !== -1; at = source.indexOf("]]", at + 1)) ends.push(at);
  let endK = 0;
  /** The first `]]` at or after `from` and before `limit`, or -1. The pointer only moves forward. */
  const linkEnd = (from: number, limit: number): number => {
    while (endK < ends.length && (ends[endK] as number) < from) {
      work(st);
      endK++;
    }
    const e = ends[endK];
    return e !== undefined && e < limit ? e : -1;
  };
  const next = new Map<string, number>(Array.from(MARKERS, (m) => [m, 0]));
  /** The first closer of `m` after `from` and before `limit`, or -1. Pointers only move forward. */
  const closer = (m: string, from: number, limit: number): number => {
    const list = closers.get(m) as number[];
    let k = next.get(m) as number;
    while (k < list.length && (list[k] as number) <= from) {
      work(st);
      k++;
    }
    next.set(m, k);
    const c = list[k];
    return c !== undefined && c < limit ? c : -1;
  };
  const run = (from: number, to: number, depth: number): MdInline[] => {
    const out: MdInline[] = [];
    let text = "";
    const flush = () => {
      if (text !== "" && take(st)) out.push({ type: "text", text });
      text = "";
    };
    let i = from;
    while (i < to) {
      work(st);
      const c = source[i] as string;
      if (c === "[" && source.startsWith("[[", i)) {
        const end = linkEnd(i + 2, to);
        if (end !== -1) {
          const inner = source.slice(i + 2, end);
          const split = inner.indexOf("][");
          const url = split === -1 ? inner : inner.slice(0, split);
          const label = split === -1 ? inner : inner.slice(split + 2);
          const href = safeLinkHref(url);
          if (href) {
            flush();
            if (!take(st)) return out;
            out.push({ type: "link", href, children: [{ type: "text", text: label }] });
          } else text += label;
          work(st, end + 2 - i);
          i = end + 2;
          continue;
        }
      }
      const opens =
        MARKERS.includes(c) &&
        (i === 0 || PRE.test(source[i - 1] as string)) &&
        i + 1 < to &&
        !/\s/.test(source[i + 1] as string);
      const close = opens ? closer(c, i + 1, to) : -1;
      if (close !== -1) {
        flush();
        if (!take(st)) return out;
        if (c === "=" || c === "~") out.push({ type: "code", text: source.slice(i + 1, close) });
        else {
          const children =
            depth < MD_MAX_INLINE_DEPTH
              ? run(i + 1, close, depth + 1)
              : [{ type: "text" as const, text: source.slice(i + 1, close) }];
          out.push({ type: c === "*" ? "strong" : "em", children });
        }
        i = close + 1;
        continue;
      }
      text += c;
      i++;
    }
    flush();
    return out;
  };
  return run(0, source.length, 0);
}
