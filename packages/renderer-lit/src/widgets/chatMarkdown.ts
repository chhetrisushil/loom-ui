import {
  type MdBlock,
  type MdDoc,
  type MdInline,
  mdPlainText,
  safeLinkHref,
} from "@loom-ui/core/chat-ui";
import { type TemplateResult, html, nothing } from "lit";
import { say } from "../say";

// ── Markdown parts of a transcript, drawn (U8c) ─────────────────────────────────────────────────────
//
// `drawMarkdown` turns the AST of `parseChatMarkdown` (core) into Lit templates. The ONLY dynamic things in
// those templates are text bindings (a node's text) and attribute bindings: a link's `href` and `title`, a heading's
// `aria-level` and class, a list's `start`, a cell's `data-align`, a code block's `data-lang`, and the `aria-label`
// of a table and of a code block (fixed words, a table's number). The parser already bounds each value; this file
// does not trust it: `href` goes through `safeLinkHref` and a scheme test again, a heading level is clamped to 1..6, `lang`
// must be a short token, `align` one of three words, `start` a small integer, a text node a string, and a node of
// a type it does not know (or a malformed one) is drawn as nothing. No `unsafeHTML`, no `innerHTML`,
// no `insertAdjacentHTML`, no `style`, no event attribute: a test scans this file for them and walks the rendered
// DOM for any tag, attribute or address outside the list below; another feeds this function forged nodes.
//
// LINKS: http(s) ones open in a new browsing context (`target="_blank"`), a mailto one does not. All carry
// `rel="noopener noreferrer nofollow"` and no referrer: a reader leaving a transcript must not hand the destination the
// transcript's address, and a link the model wrote is not an endorsement. The address is also the link's `title`, and the
// destination HOST (punycode for an international name) is shown after the label unless the label IS that site (the same
// host, or the whole address), so a label cannot pass for another site. A mailto link names one address only.

export interface MarkdownDraw {
  /** How a numbered reference marker is drawn (the same button a plain-text marker gets). */
  readonly ref: (id: string, n: number) => TemplateResult;
}

const arr = <T>(x: readonly T[] | undefined): readonly T[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** `host` without a leading `www.`, lower case. */
const site = (host: string): string => host.toLowerCase().replace(/^www\./, "");

/** The host a label names, when the label is nothing but an address or a bare host name. */
function labelHost(label: string): string | undefined {
  const l = label.trim();
  if (l === "" || /[\s\\@]/.test(l)) return undefined;
  try {
    if (/^https?:\/\//i.test(l)) return new URL(l).host;
    if (/^[^/?#:]+\.[^/?#:]+$/.test(l)) return new URL(`http://${l}`).host;
  } catch {
    // not an address
  }
  return undefined;
}

type Dest = { readonly href: string; readonly host: string; readonly web: boolean };

/** Where a link goes, or undefined when it is not a link this transcript may carry. */
function destination(raw: unknown): Dest | undefined {
  const href = typeof raw === "string" ? safeLinkHref(raw) : undefined; // the parser applied the same rule
  if (href === undefined) return undefined;
  try {
    if (/^mailto:/i.test(href)) {
      const addr = href.slice(7).split("?")[0] ?? "";
      const at = addr.indexOf("@");
      // one address: no list (`,` `;`), one `@`, something on both sides
      if (at < 1 || at !== addr.lastIndexOf("@") || /[,;]/.test(addr)) return undefined;
      const host = new URL(`http://${addr.slice(at + 1)}`).host;
      return host === "" ? undefined : { href, host, web: false };
    }
    if (!/^https?:/i.test(href)) return undefined;
    return { href, host: new URL(href).host, web: true };
  } catch {
    return undefined;
  }
}

/** Does the label say the very site the link goes to? */
function labelIsSite(label: string, d: Dest): boolean {
  if (label.trim() === d.href) return true;
  const named = labelHost(label);
  return named !== undefined && site(named) === site(d.host);
}

const LANG = /^[A-Za-z0-9_+#.-]{1,24}$/;
const ALIGN = new Set(["left", "center", "right"]);
const align = (a: unknown): string | typeof nothing =>
  typeof a === "string" && ALIGN.has(a) ? a : nothing;

interface Ctx {
  readonly d: MarkdownDraw;
  tables: number;
}

const inlines = (nodes: readonly MdInline[] | undefined, c: Ctx): unknown[] =>
  arr(nodes).map((n) => inline(n, c));

function inline(n: MdInline, c: Ctx): unknown {
  switch ((n as { type?: unknown } | null)?.type) {
    case "text":
      return str((n as { text?: unknown }).text);
    case "code":
      return html`<code>${str((n as { text?: unknown }).text)}</code>`;
    case "em":
      return html`<em>${inlines((n as { children?: readonly MdInline[] }).children, c)}</em>`;
    case "strong":
      return html`<strong>${inlines((n as { children?: readonly MdInline[] }).children, c)}</strong>`;
    case "link": {
      const l = n as { href?: unknown; children?: readonly MdInline[] };
      const dest = destination(l.href);
      if (dest === undefined) return inlines(l.children, c);
      const shown =
        dest.host === "" || labelIsSite(mdPlainText(arr(l.children)), dest)
          ? nothing
          : html`<span class="dest"> (${dest.host})</span>`;
      const tab = dest.web ? html`<span class="sr-only"> ${say("lu.chat.newTab")}</span>` : nothing;
      return html`<a href=${dest.href} title=${dest.href} target=${dest.web ? "_blank" : nothing} rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">${inlines(l.children, c)}${shown}${tab}</a>`;
    }
    case "br":
      return html`<br />`;
    case "ref": {
      const r = n as { id?: unknown; n?: unknown };
      return typeof r.id === "string" && typeof r.n === "number" ? c.d.ref(r.id, r.n) : nothing;
    }
    default:
      return nothing; // an unresolved marker, or a node this file does not know, is never drawn
  }
}

function block(b: MdBlock, c: Ctx): unknown {
  switch ((b as { type?: unknown } | null)?.type) {
    case "paragraph":
      return html`<p>${inlines((b as { inlines?: readonly MdInline[] }).inlines, c)}</p>`;
    case "heading": {
      const h = b as { level?: unknown; inlines?: readonly MdInline[] };
      const level =
        h.level === 1 || h.level === 2 || h.level === 3 || h.level === 4 || h.level === 5
          ? h.level
          : 6;
      // A transcript is not a page: its headings sit below the page's own, so `#` is level 3 and the deepest is 6.
      return html`<div class="h h${level}" role="heading" aria-level=${Math.min(6, level + 2)}>${inlines(h.inlines, c)}</div>`;
    }
    case "code": {
      const k = b as { lang?: unknown; text?: unknown };
      const lang = typeof k.lang === "string" && LANG.test(k.lang) ? k.lang : nothing;
      return html`<pre tabindex="0" role="region" aria-label=${say("lu.chat.code")}><code data-lang=${lang}>${str(k.text)}</code></pre>`;
    }
    case "quote":
      return html`<blockquote>${arr((b as { blocks?: readonly MdBlock[] }).blocks).map((x) => block(x, c))}</blockquote>`;
    case "list": {
      const l = b as {
        ordered?: unknown;
        start?: unknown;
        items?: readonly (readonly MdBlock[])[];
      };
      const items = arr(l.items).map((item) => html`<li>${arr(item).map((x) => block(x, c))}</li>`);
      const start =
        typeof l.start === "number" && Number.isSafeInteger(l.start) && l.start >= 0 ? l.start : 1;
      return l.ordered === true ? html`<ol start=${start}>${items}</ol>` : html`<ul>${items}</ul>`;
    }
    case "table": {
      const t = b as {
        align?: readonly unknown[];
        head?: readonly (readonly MdInline[])[];
        rows?: readonly (readonly (readonly MdInline[])[])[];
      };
      const al = arr(t.align);
      const n = ++c.tables;
      return html`<div class="table" tabindex="0" role="region" aria-label=${say("lu.chat.table", { n })}><table>
        <thead><tr>${arr(t.head).map((cell, k) => html`<th scope="col" data-align=${align(al[k])}>${inlines(cell, c)}</th>`)}</tr></thead>
        <tbody>${arr(t.rows).map((r) => html`<tr>${arr(r).map((cell, k) => html`<td data-align=${align(al[k])}>${inlines(cell, c)}</td>`)}</tr>`)}</tbody>
      </table></div>`;
    }
    case "rule":
      return html`<hr />`;
    default:
      return nothing;
  }
}

/** The document as Lit templates. A document a bound cut short ends in an ellipsis, with the fact said in words for a screen reader. */
export function drawMarkdown(doc: MdDoc, d: MarkdownDraw): TemplateResult {
  const c: Ctx = { d, tables: 0 };
  return html`${arr(doc.blocks).map((b) => block(b, c))}${doc.truncated === true ? html`<p class="cut"><span aria-hidden="true">…</span><span class="sr-only">${say("lu.chat.cut")}</span></p>` : nothing}`;
}
