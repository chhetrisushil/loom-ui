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
// those templates are text bindings (a node's text) and three attribute bindings (a link's `href` and `title`,
// a heading's `aria-level`, a list's `start`, a cell's `data-align`, a code block's `data-lang`), each of them a
// value the parser bounded and this file re-checks (`safeLinkHref`). No `unsafeHTML`, no `innerHTML`, no
// `insertAdjacentHTML`, no `style`, no event attribute: a test scans this file for them and walks the rendered
// DOM for any tag, attribute or address outside the list below.
//
// LINKS open in a new browsing context (`target="_blank"`) with `rel="noopener noreferrer nofollow"` and no
// referrer: a reader leaving a transcript must not hand the destination the transcript's address, and a link
// the model wrote is not an endorsement. The address is also the link's `title`, and its host is shown after the label
// (unless the label already says it), so a label cannot pass for another site.

export interface MarkdownDraw {
  /** How a numbered reference marker is drawn (the same button a plain-text marker gets). */
  readonly ref: (id: string, n: number) => TemplateResult;
}

/** The host a link goes to: an http(s) authority (as the URL parser normalises it, so an IDN shows as punycode) or a mailto domain. */
function linkHost(href: string): string {
  if (/^mailto:/i.test(href)) {
    const addr = href.slice(7).split("?")[0] ?? "";
    return addr.slice(addr.lastIndexOf("@") + 1);
  }
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
}

const inlines = (nodes: readonly MdInline[], d: MarkdownDraw): unknown[] =>
  nodes.map((n) => inline(n, d));

function inline(n: MdInline, d: MarkdownDraw): unknown {
  switch (n.type) {
    case "text":
      return n.text;
    case "code":
      return html`<code>${n.text}</code>`;
    case "em":
      return html`<em>${inlines(n.children, d)}</em>`;
    case "strong":
      return html`<strong>${inlines(n.children, d)}</strong>`;
    case "link": {
      const href = safeLinkHref(n.href); // defence in depth: the parser already applied the same rule
      if (href === undefined || !/^(https?:|mailto:)/i.test(href)) return inlines(n.children, d);
      const host = linkHost(href);
      const label = mdPlainText(n.children).toLowerCase();
      const dest =
        host === "" || label.includes(host.toLowerCase())
          ? nothing
          : html`<span class="dest"> (${host})</span>`;
      return html`<a href=${href} title=${href} target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">${inlines(n.children, d)}${dest}</a>`;
    }
    case "br":
      return html`<br />`;
    case "ref":
      return d.ref(n.id, n.n);
    default:
      return nothing; // an unresolved marker is never drawn
  }
}

function block(b: MdBlock, d: MarkdownDraw): TemplateResult {
  switch (b.type) {
    case "paragraph":
      return html`<p>${inlines(b.inlines, d)}</p>`;
    case "heading":
      // A transcript is not a page: its headings sit below the page's own, so `#` is level 3 and the deepest is 6.
      return html`<div class="h h${b.level}" role="heading" aria-level=${Math.min(6, b.level + 2)}>${inlines(b.inlines, d)}</div>`;
    case "code":
      return html`<pre tabindex="0"><code data-lang=${b.lang ?? nothing}>${b.text}</code></pre>`;
    case "quote":
      return html`<blockquote>${b.blocks.map((x) => block(x, d))}</blockquote>`;
    case "list": {
      const items = b.items.map((item) => html`<li>${item.map((x) => block(x, d))}</li>`);
      return b.ordered ? html`<ol start=${b.start}>${items}</ol>` : html`<ul>${items}</ul>`;
    }
    case "table":
      return html`<div class="table" tabindex="0" role="region" aria-label=${say("lu.chat.table")}><table>
        <thead><tr>${b.head.map((c, k) => html`<th scope="col" data-align=${b.align[k] ?? nothing}>${inlines(c, d)}</th>`)}</tr></thead>
        <tbody>${b.rows.map((r) => html`<tr>${r.map((c, k) => html`<td data-align=${b.align[k] ?? nothing}>${inlines(c, d)}</td>`)}</tr>`)}</tbody>
      </table></div>`;
    case "rule":
      return html`<hr />`;
  }
}

/** The document as Lit templates. A document a bound cut short ends in an ellipsis nobody has to read out. */
export function drawMarkdown(doc: MdDoc, d: MarkdownDraw): TemplateResult {
  return html`${doc.blocks.map((b) => block(b, d))}${doc.truncated ? html`<p class="cut" aria-hidden="true">…</p>` : nothing}`;
}
