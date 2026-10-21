import { destAt, markerAt, tickRuns } from "./chatMdScan";
import {
  MD_MAX_INLINE_DEPTH,
  type MdInline,
  type MdState,
  mdPlainText,
  safeLinkHref,
  take,
  work,
} from "./chatMdTypes";
import { partialRefMarkerAt } from "./chatRefs";

// ── Markdown inlines: escapes, code spans, links, images, markers, emphasis (U8c) ───────────────────

const MAX_DELIMS = 200;
// A delimiter run longer than this is literal text: it could only nest one level per two characters, and the tree is
// flattened past MD_MAX_INLINE_DEPTH anyway.
const MAX_DELIM_RUN = 2 * MD_MAX_INLINE_DEPTH;

type Node = MdInline | Delim | Bracket;
interface Delim {
  readonly type: "delim";
  readonly ch: string;
  count: number;
  readonly open: boolean;
  readonly close: boolean;
}
interface Bracket {
  readonly type: "bracket";
  readonly image: boolean;
}
const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const isWs = (c: string | undefined): boolean => c === undefined || c === " " || c === "\n";
const hasLink = (nodes: readonly Node[]): boolean =>
  nodes.some(
    (n) => n.type === "link" || ((n.type === "em" || n.type === "strong") && hasLink(n.children))
  );
/** `nodes` without any reference marker, at every depth (a marker is never drawn inside a link label). */
const dropMarkers = (nodes: readonly MdInline[]): MdInline[] => {
  const out: MdInline[] = [];
  for (const n of nodes) {
    if (n.type === "marker") continue;
    out.push(
      n.type === "em" || n.type === "strong" || n.type === "link"
        ? { ...n, children: dropMarkers(n.children) }
        : n
    );
  }
  return out;
};

/** Resolve emphasis over `nodes` (CommonMark's delimiter-stack rules) and turn what is left of delimiters and brackets into text. */
function settle(nodes: Node[], st: MdState): MdInline[] {
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci] as Node;
    if (closer.type !== "delim" || !closer.close || closer.count === 0) {
      ci++;
      continue;
    }
    let oi = ci - 1;
    let opener: Delim | undefined;
    while (oi >= 0) {
      const o = nodes[oi] as Node;
      if (
        o.type === "delim" &&
        o.ch === closer.ch &&
        o.open &&
        o.count > 0 &&
        !(
          (o.close || closer.open) &&
          (o.count + closer.count) % 3 === 0 &&
          !(o.count % 3 === 0 && closer.count % 3 === 0)
        )
      ) {
        opener = o;
        break;
      }
      oi--;
      work(st);
    }
    if (!opener) {
      ci++;
      continue;
    }
    const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    work(st, ci - oi);
    const inner = finish(nodes.slice(oi + 1, ci));
    opener.count -= use;
    closer.count -= use;
    nodes.splice(oi + 1, ci - oi - 1, { type: use === 2 ? "strong" : "em", children: inner });
    ci = oi + 2;
    if (closer.count === 0) ci++;
  }
  return finish(nodes);
}
function finish(nodes: readonly Node[]): MdInline[] {
  const out: MdInline[] = [];
  const push = (n: MdInline): void => {
    const prev = out[out.length - 1];
    if (n.type === "text" && prev?.type === "text")
      out[out.length - 1] = { type: "text", text: prev.text + n.text };
    else if (!(n.type === "text" && n.text === "")) out.push(n);
  };
  for (const n of nodes) {
    if (n.type === "delim") push({ type: "text", text: n.ch.repeat(n.count) });
    else if (n.type === "bracket") push({ type: "text", text: n.image ? "![" : "[" });
    else push(n);
  }
  return out;
}

/** Parse one run of inline text (a paragraph, a heading, a table cell) into at most the remaining node budget. */
export function parseInlines(source: string, st: MdState): MdInline[] {
  let src = source;
  if (st.streaming && st.markers) {
    const open = partialRefMarkerAt(src);
    if (open >= 0) {
      src = src.slice(0, open);
      if (src.endsWith(" ")) src = src.slice(0, -1);
    }
  }
  const out: Node[] = [];
  const ticks = tickRuns(src);
  let tick = 0;
  let delims = 0;
  const brackets: number[] = [];
  work(st, src.length);
  let buf = "";
  const flush = (): void => {
    if (buf !== "") out.push({ type: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    work(st);
    const c = src[i] as string;
    if (c === "\\") {
      const nx = src[i + 1];
      if (nx === "\n") {
        flush();
        out.push({ type: "br" });
        i += 2;
      } else if (nx !== undefined && /[!-/:-@[-`{-~]/.test(nx)) {
        buf += nx;
        i += 2;
      } else {
        buf += c;
        i++;
      }
    } else if (c === "\n") {
      if (buf.endsWith("  ")) {
        buf = buf.trimEnd();
        flush();
        out.push({ type: "br" });
      } else buf = `${buf.trimEnd()}\n`;
      i++;
      while (src[i] === " ") i++;
    } else if (c === "`") {
      while (
        tick < ticks.length &&
        (ticks[tick] as { pos: number; len: number }).pos + (ticks[tick] as { len: number }).len <=
          i
      )
        tick++;
      const run = ticks[tick];
      if (!run || run.pos < i) {
        // the run was split by an escape (`\\``): what is left of it is literal
        const end = run ? run.pos + run.len : i + 1;
        buf += src.slice(i, end);
        i = end;
        continue;
      }
      const close = run.next < 0 ? undefined : (ticks[run.next] as { pos: number });
      if (!close) {
        buf += "`".repeat(run.len);
        i += run.len;
      } else {
        flush();
        let code = src.slice(i + run.len, close.pos).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "")
          code = code.slice(1, -1);
        out.push({ type: "code", text: code });
        i = close.pos + run.len;
      }
    } else if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const mk = st.markers && c === "[" ? markerAt(src, i) : undefined;
      if (mk) {
        flush();
        out.push({ type: "marker", id: mk.id });
        i = mk.end;
      } else {
        flush();
        const image = c === "!";
        brackets.push(out.length);
        out.push({ type: "bracket", image });
        i += image ? 2 : 1;
      }
    } else if (c === "]") {
      const bi = brackets.length > 0 ? (brackets[brackets.length - 1] as number) : -1;
      const dest = bi >= 0 && src[i + 1] === "(" ? destAt(src, i + 1, st.meter) : undefined;
      const pending = st.streaming && bi >= 0 && (i + 1 === src.length || dest === "eof");
      if (bi < 0 || (typeof dest !== "object" && !pending)) {
        // no opener, or none that closes here: the `]` is text and the opener is spent
        brackets.pop();
        buf += "]";
        i++;
        continue;
      }
      brackets.pop();
      flush();
      const bracket = out[bi] as Bracket;
      const inner = out.splice(bi);
      inner.shift();
      const label = dropMarkers(settle(inner, st));
      if (dest === undefined || dest === "eof") {
        // streaming: `[label](half-written` or `[label]` at the very end: the label, nothing else, until it settles
        for (const n of label) out.push(n);
        i = dest === "eof" ? src.length : i + 1;
      } else if (bracket.image) {
        out.push({ type: "text", text: mdPlainText(label) });
        i = dest.end;
      } else if (hasLink(label)) {
        out.push({ type: "text", text: "[" }, ...label, { type: "text", text: "]" });
        i++;
      } else {
        const href = safeLinkHref(dest.href);
        if (href) out.push({ type: "link", href, children: label });
        else for (const n of label) out.push(n);
        i = dest.end;
      }
    } else if (c === "*" || c === "_") {
      let k = i;
      while (src[k] === c) k++;
      const count = k - i;
      const before = src[i - 1];
      const after = src[k];
      const wsB = isWs(before);
      const wsA = isWs(after);
      const pB = before !== undefined && PUNCT.test(before);
      const pA = after !== undefined && PUNCT.test(after);
      const left = !wsA && (!pA || wsB || pB);
      const right = !wsB && (!pB || wsA || pA);
      const open = c === "*" ? left : left && (!right || pB);
      const close = c === "*" ? right : right && (!left || pA);
      if (count <= MAX_DELIM_RUN && delims < MAX_DELIMS && (open || close)) {
        flush();
        delims++;
        out.push({ type: "delim", ch: c, count, open, close });
      } else buf += c.repeat(count);
      i = k;
    } else {
      buf += c;
      i++;
    }
  }
  buf = buf.trimEnd();
  flush();
  return limit(settle(out, st), MD_MAX_INLINE_DEPTH, st);
}

/** Flatten nesting deeper than `depth` and charge every node to the budget (the rest is cut). */
function limit(nodes: readonly MdInline[], depth: number, st: MdState): MdInline[] {
  const out: MdInline[] = [];
  for (const n of nodes) {
    if ((n.type === "em" || n.type === "strong" || n.type === "link") && depth <= 1) {
      for (const c of limit(n.children, 1, st)) out.push(c);
      continue;
    }
    if (!take(st)) break;
    out.push(
      n.type === "em" || n.type === "strong" || n.type === "link"
        ? { ...n, children: limit(n.children, depth - 1, st) }
        : n
    );
  }
  return out;
}
