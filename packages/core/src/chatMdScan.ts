// ── Markdown scanning helpers: reference markers, code-span runs, link destinations (U8c) ──────────
// Each is a single pass (or a pre-indexed lookup), so the inline parser stays linear.

import { MD_MAX_URL } from "./chatMdTypes";
import { refMarkerAt } from "./chatRefs";

/** A `[[id]]` marker at `at`. The id pattern is the one `splitRefMarkers` uses (`chatRefs.ts`), not a second one. */
export function markerAt(s: string, at: number): { id: string; end: number } | undefined {
  return s[at] === "[" ? refMarkerAt(s, at) : undefined;
}

/** Index of every backtick run, and for each the next run of the SAME length: code spans in O(n). */
export function tickRuns(s: string): { pos: number; len: number; next: number }[] {
  const runs: { pos: number; len: number; next: number }[] = [];
  for (let k = 0; k < s.length; ) {
    if (s[k] !== "`") {
      k++;
      continue;
    }
    const pos = k;
    while (s[k] === "`") k++;
    runs.push({ pos, len: k - pos, next: -1 });
  }
  const last = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r] as { len: number; next: number };
    run.next = last.get(run.len) ?? -1;
    last.set(run.len, r);
  }
  return runs;
}

/**
 * The destination of `(dest "title")` starting at `src[at] === "("`: its end (after the `)`), or undefined; `eof` when the
 * text ended first. Every scan is cut at {@link MD_MAX_URL} characters (a longer destination or title is no link), so one call
 * costs O(MD_MAX_URL) however long the text is.
 */
export function destAt(
  src: string,
  at: number,
  meter?: { steps: number }
): { href: string; end: number } | "eof" | undefined {
  const start = at;
  const done = <T>(r: T, k: number): T => {
    if (meter) meter.steps += k - start + 1;
    return r;
  };
  const cap = MD_MAX_URL + 2;
  let k = at + 1;
  while (src[k] === " " && k - at <= cap) k++;
  let href: string;
  if (src[k] === "<") {
    const from = k + 1;
    let e = from;
    while (e < src.length && e - from <= cap && src[e] !== ">" && src[e] !== "\n") e++;
    if (e >= src.length) return done("eof", e);
    if (src[e] !== ">") return done(undefined, e);
    href = src.slice(from, e);
    k = e + 1;
  } else {
    const from = k;
    let depth = 0;
    while (k < src.length && src[k] !== " " && src[k] !== "\n") {
      if (k - from > cap) return done(undefined, k);
      if (src[k] === "\\" && k + 1 < src.length) k++;
      else if (src[k] === "(") depth++;
      else if (src[k] === ")") {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    href = src.slice(from, k).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (src[k] === " " && k - at <= 2 * cap) k++;
  if (src[k] === '"' || src[k] === "'") {
    const q = src[k] as string;
    const from = k + 1;
    let e = from;
    while (e < src.length && e - from <= cap && src[e] !== q) e++;
    if (e >= src.length) return done("eof", e);
    if (src[e] !== q) return done(undefined, e);
    k = e + 1;
    while (src[k] === " " && k - e <= cap) k++;
  }
  if (k >= src.length) return done("eof", k);
  return done(src[k] === ")" ? { href, end: k + 1 } : undefined, k);
}
