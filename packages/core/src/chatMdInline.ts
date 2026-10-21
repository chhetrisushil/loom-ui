import { destAt, markerAt, tickRuns } from "./chatMdScan";
import {
  MD_MAX_INLINE_DEPTH,
  type MdInline,
  type MdState,
  mdPlainText,
  safeLinkHref,
  take,
} from "./chatMdTypes";
import { partialRefMarkerAt } from "./chatRefs";

// ── Markdown inlines: escapes, code spans, links, images, markers (U8c) ───────────────────

type Node = MdInline | Bracket;
interface Bracket {
  readonly type: "bracket";
  readonly image: boolean;
}
const hasLink = (nodes: readonly Node[]): boolean =>
  nodes.some(
    (n) => n.type === "link" || ((n.type === "em" || n.type === "strong") && hasLink(n.children))
  );

function finish(nodes: readonly Node[]): MdInline[] {
  const out: MdInline[] = [];
  const push = (n: MdInline): void => {
    const prev = out[out.length - 1];
    if (n.type === "text" && prev?.type === "text")
      out[out.length - 1] = { type: "text", text: prev.text + n.text };
    else if (!(n.type === "text" && n.text === "")) out.push(n);
  };
  for (const n of nodes) {
    if (n.type === "bracket") push({ type: "text", text: n.image ? "![" : "[" });
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
  let buf = "";
  const flush = (): void => {
    if (buf !== "") out.push({ type: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
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
      while (tick < ticks.length && (ticks[tick] as { pos: number }).pos < i) tick++;
      const run = ticks[tick] as { pos: number; len: number; next: number };
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
        out.push({ type: "bracket", image });
        i += image ? 2 : 1;
      }
    } else if (c === "]") {
      let bi = out.length - 1;
      while (bi >= 0 && (out[bi] as Node).type !== "bracket") bi--;
      const dest = bi >= 0 && src[i + 1] === "(" ? destAt(src, i + 1) : undefined;
      const pending = st.streaming && bi >= 0 && (i + 1 === src.length || dest === "eof");
      if (
        bi < 0 ||
        (dest === undefined && !pending) ||
        (dest !== undefined && dest !== "eof" ? false : !pending)
      ) {
        buf += "]";
        i++;
        continue;
      }
      flush();
      const bracket = out[bi] as Bracket;
      const inner = out.splice(bi);
      inner.shift();
      const kids = finish(inner);
      const label = kids.filter((n) => n.type !== "marker");
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
    } else {
      buf += c;
      i++;
    }
  }
  buf = buf.trimEnd();
  flush();
  return limit(finish(out), MD_MAX_INLINE_DEPTH, st);
}

/** Flatten nesting deeper than `depth` and charge every node to the budget (the rest is cut). */
function limit(nodes: readonly MdInline[], depth: number, st: MdState): MdInline[] {
  const out: MdInline[] = [];
  for (const n of nodes) {
    if ((n.type === "em" || n.type === "strong" || n.type === "link") && depth <= 1) {
      out.push(...limit(n.children, 1, st));
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
