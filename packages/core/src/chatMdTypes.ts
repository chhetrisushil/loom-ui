// ── Markdown in a chat transcript: the AST, its bounds and the link rule (U8c) ──────────────────────
// See `chatMarkdown.ts` for the whole contract. Zod-free and DOM-free; nothing here produces HTML.

export const MD_MAX_NODES = 2000;
export const MD_MAX_DEPTH = 6;
export const MD_MAX_INLINE_DEPTH = 4;
export const MD_MAX_TABLE_COLS = 12;
export const MD_MAX_TABLE_ROWS = 100;
export const MD_MAX_URL = 2048;
export type MdAlign = "left" | "center" | "right" | null;
export type MdInline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "em"; readonly children: readonly MdInline[] }
  | { readonly type: "strong"; readonly children: readonly MdInline[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly MdInline[] }
  | { readonly type: "br" }
  /** A `[[id]]` marker as parsed: not yet checked against the entry's `refs`. A renderer never draws it. */
  | { readonly type: "marker"; readonly id: string }
  /** A marker the entry listed, numbered by first appearance ({@link resolveMdMarkers}). */
  | { readonly type: "ref"; readonly id: string; readonly n: number };
export type MdBlock =
  | { readonly type: "paragraph"; readonly inlines: readonly MdInline[] }
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly inlines: readonly MdInline[];
    }
  | { readonly type: "code"; readonly lang?: string; readonly text: string }
  | { readonly type: "quote"; readonly blocks: readonly MdBlock[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly MdBlock[])[];
    }
  | {
      readonly type: "table";
      readonly align: readonly MdAlign[];
      readonly head: readonly (readonly MdInline[])[];
      readonly rows: readonly (readonly (readonly MdInline[])[])[];
    }
  | { readonly type: "rule" };
export interface MdDoc {
  readonly blocks: readonly MdBlock[];
  /** A bound cut the document short. */
  readonly truncated: boolean;
}
export interface ChatMarkdownOptions {
  /** The source writes `[[id]]` markers (`ChatValue.refMarkers`). Off: `[[id]]` is ordinary text. */
  readonly markers?: boolean;
  /** The reply is still arriving. */
  readonly streaming?: boolean;
}

export interface MdState {
  nodes: number;
  truncated: boolean;
  readonly markers: boolean;
  readonly streaming: boolean;
  /** Test-only work counter: bumped once per scanned character or delimiter step. Absent in production. */
  readonly meter?: { steps: number };
}
/** Charge `n` steps to the work counter, when there is one. */
export const work = (st: { readonly meter?: { steps: number } }, n = 1): void => {
  if (st.meter) st.meter.steps += n;
};
export const take = (st: MdState): boolean => {
  if (st.nodes >= MD_MAX_NODES) {
    st.truncated = true;
    return false;
  }
  st.nodes++;
  return true;
};

// ── links ─────────────────────────────────────────────────────────────────────────────────────────

/** `raw` if it is a link a transcript may carry (http, https, mailto; no whitespace, controls, backslash or userinfo), else undefined. */
export function safeLinkHref(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MD_MAX_URL) return undefined;
  for (let k = 0; k < raw.length; k++) {
    const c = raw.charCodeAt(k);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x5c) return undefined;
  }
  const lower = raw.slice(0, 8).toLowerCase();
  if (lower.startsWith("mailto:")) return raw.length > 7 ? raw : undefined;
  const web = lower.startsWith("https://") ? 8 : lower.startsWith("http://") ? 7 : 0;
  if (web === 0) return undefined;
  let end = web;
  while (end < raw.length && raw[end] !== "/" && raw[end] !== "?" && raw[end] !== "#") end++;
  const authority = raw.slice(web, end);
  return authority === "" || authority.includes("@") ? undefined : raw;
}

/** The text of inline nodes with no markup (an image's alt text, an accessible name). */
export function mdPlainText(nodes: readonly MdInline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text" || n.type === "code") out += n.text;
    else if (n.type === "br") out += " ";
    else if (n.type === "em" || n.type === "strong" || n.type === "link")
      out += mdPlainText(n.children);
  }
  return out;
}
