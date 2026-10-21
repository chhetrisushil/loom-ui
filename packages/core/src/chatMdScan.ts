// ── Markdown scanning helpers: reference markers, code-span runs, link destinations (U8c) ──────────
// Each is a single pass (or a pre-indexed lookup), so the inline parser stays linear.

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

/** The destination of `(dest "title")` starting at `src[at] === "("`: its end (after the `)`), or undefined; `eof` when the text ended first. */
export function destAt(src: string, at: number): { href: string; end: number } | "eof" | undefined {
  let k = at + 1;
  while (src[k] === " ") k++;
  let href: string;
  if (src[k] === "<") {
    const close = src.indexOf(">", k);
    if (close < 0 || src.slice(k, close).includes("\n"))
      return close < 0 && !src.includes("\n", k) ? "eof" : undefined;
    href = src.slice(k + 1, close);
    k = close + 1;
  } else {
    const from = k;
    let depth = 0;
    while (k < src.length && src[k] !== " " && src[k] !== "\n") {
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
  while (src[k] === " ") k++;
  if (src[k] === '"' || src[k] === "'") {
    const q = src[k] as string;
    const close = src.indexOf(q, k + 1);
    if (close < 0) return "eof";
    k = close + 1;
    while (src[k] === " ") k++;
  }
  if (k >= src.length) return "eof";
  return src[k] === ")" ? { href, end: k + 1 } : undefined;
}
