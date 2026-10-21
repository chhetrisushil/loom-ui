// ── Inline reference markers ─────────────────────────────────────────────────────────────────────
// A transcript source that cites writes `[[id]]` in a text part and lists the ids an entry may cite in `refs`.
// This is NOT markup: a marker is a token the WIDGET replaces with a button it builds itself, and only for an id the
// host listed. Unlisted markers are removed; while a reply streams every marker is hidden (the cited set is known only
// when the reply is durable).

export const CHAT_REF_OPEN_ACTION = "CHAT_REF_OPEN";
export const MAX_CHAT_REFS = 64;

export type RefSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "ref"; readonly id: string; readonly n: number };

const MARKER = /\[\[([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]\]/g;
// `[[`, then up to 128 id characters, then at most one `]`, at the very end: a marker still arriving.
const PARTIAL = /\[\[[A-Za-z0-9._:-]{0,128}\]?$/;

/**
 * Split `text` into text and numbered reference segments. A marker whose id is in `known` becomes a `ref`
 * (numbered by first appearance of the id); every other marker is removed with one space before it. With
 * `hideAll` (a streaming reply) every marker, and a trailing half-written `[[...`, is removed. Linear.
 */
export function splitRefMarkers(
  text: string,
  known: ReadonlySet<string>,
  o: { readonly hideAll: boolean }
): RefSegment[] {
  const out: RefSegment[] = [];
  const numbers = new Map<string, number>();
  let buf = "";
  const flush = (): void => {
    if (buf !== "") out.push({ type: "text", text: buf });
    buf = "";
  };
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const at = m.index as number;
    buf += text.slice(last, at);
    last = at + m[0].length;
    const id = m[1] as string;
    if (o.hideAll || !known.has(id)) {
      if (buf.endsWith(" ")) buf = buf.slice(0, -1);
      continue;
    }
    let n = numbers.get(id);
    if (n === undefined) {
      n = numbers.size + 1;
      numbers.set(id, n);
    }
    flush();
    out.push({ type: "ref", id, n });
  }
  buf += text.slice(last);
  if (o.hideAll) {
    const tail = PARTIAL.exec(buf);
    if (tail) {
      buf = buf.slice(0, tail.index);
      if (buf.endsWith(" ")) buf = buf.slice(0, -1);
    }
  }
  flush();
  return out;
}
