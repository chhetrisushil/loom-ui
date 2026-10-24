import type { ProseValue } from "@loom-ui/core/browser";
import { sanitizeChatText, stripUnsafeChars } from "@loom-ui/core/chat-ui";
import {
  MD_DOC_MAX_TEXT,
  type MdDocument,
  parseMarkdownDocument,
  parseOrgDocument,
} from "@loom-ui/core/document";
import { type PropertyValues, type TemplateResult, css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { say } from "../say";
import { LuWidget } from "./base";
import { drawMarkdown, markdownStyles } from "./chatMarkdown";

// Long formatted text (a whole document): markdown and org are parsed by core's document parsers and drawn by the
// same hardened `drawMarkdown` as chat, one call per top-level block (drawMarkdown caps the nodes of ONE call), each
// in its own wrapper. The first PAGE blocks are drawn, then a Show more button. A `focus` range draws up to the block
// that overlaps it, marks that block and scrolls it into view once per distinct focus.
const PAGE = 300;
const noRef = (): TemplateResult => html``;

export class LuProse extends LuWidget {
  readonly kind = "Prose";

  static styles = [
    markdownStyles,
    css`
      :host {
        display: block;
      }
      .doc {
        max-width: 72ch;
        line-height: 1.6;
      }
      [data-block] {
        scroll-margin-top: 16px;
      }
      mark[data-block].focus {
        background: transparent;
        color: inherit;
      }
      [data-block].focus {
        outline: 2px solid var(--lu-accent, #58a6ff);
        outline-offset: 4px;
        border-radius: var(--lu-radius, 6px);
      }
      pre.plain {
        white-space: pre-wrap;
        font-family: var(--lu-mono, ui-monospace, monospace);
        margin: 0;
      }
      .note,
      .cut {
        color: var(--lu-text-dim, #8b949e);
        font-size: 12px;
      }
    `,
  ];

  @state() private shown = PAGE;
  private parsed: { format: string; text: string; doc: MdDocument } | undefined;
  private plainOf:
    | { text: string; key: string; pre: string; mid: string; post: string; cut: boolean }
    | undefined;
  // The document the paging and the scroll belong to: a new one starts at the first page and may scroll again.
  private docId: string | undefined;
  private scrolledFor = "";

  private doc(v: ProseValue): MdDocument {
    if (this.parsed?.format === v.format && this.parsed.text === v.text) return this.parsed.doc;
    const doc = v.format === "org" ? parseOrgDocument(v.text) : parseMarkdownDocument(v.text);
    this.parsed = { format: v.format, text: v.text, doc };
    return doc;
  }

  // Plain text is untrusted too: control and reordering characters are removed, and a text over the document cap is
  // cut at a line break (the cut line says so). The RAW text is split at the focus first (offsets are raw), then each
  // part is stripped, so the focus lands on the right characters.
  private plain(
    text: string,
    focus: { from: number; to: number } | undefined
  ): { pre: string; mid: string; post: string; cut: boolean } {
    const key = focus ? `${focus.from}:${focus.to}` : "";
    const c = this.plainOf;
    if (c?.text === text && c.key === key) return c;
    let head = text;
    let cut = false;
    if (head.length > MD_DOC_MAX_TEXT) {
      head = head.slice(0, MD_DOC_MAX_TEXT);
      const nl = head.lastIndexOf("\n");
      if (nl > 0) head = head.slice(0, nl);
      cut = true;
    }
    let a = 0;
    let z = 0;
    if (focus && Number.isFinite(focus.from) && Number.isFinite(focus.to)) {
      a = Math.min(Math.max(focus.from, 0), head.length);
      z = Math.min(Math.max(focus.to, a), head.length);
    }
    this.plainOf = {
      text,
      key,
      pre: stripUnsafeChars(head.slice(0, a)),
      mid: stripUnsafeChars(head.slice(a, z)),
      post: stripUnsafeChars(head.slice(z)),
      cut,
    };
    return this.plainOf;
  }

  // Every block overlapping the focus is marked (the chunker starts a chunk inside the previous paragraph, so the
  // first overlapping block may be only overlap). The scroll goes to the first block that starts inside the focus,
  // else the first overlapping one. `last` is the last marked block (paging draws up to it).
  private focusInfo(
    v: ProseValue,
    doc: MdDocument
  ): { marked: Set<number>; scroll: number; last: number } {
    const marked = new Set<number>();
    if (!v.focus) return { marked, scroll: -1, last: -1 };
    const { from, to } = v.focus;
    const end = Math.max(to, from + 1);
    let scroll = -1;
    let inside = -1;
    let last = -1;
    doc.ranges.forEach((r, i) => {
      if (!(r.from < end && r.to > from)) return;
      marked.add(i);
      last = i;
      if (scroll < 0) scroll = i;
      if (inside < 0 && r.from >= from) inside = i;
    });
    return { marked, scroll: inside >= 0 ? inside : scroll, last };
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const v = this.value as ProseValue | undefined;
    if (!v || this.state().state !== "ready") return;
    const id = `${v.format}\u0000${v.text}`;
    if (id !== this.docId) {
      this.docId = id;
      this.shown = PAGE;
      this.scrolledFor = "";
    }
    // Every update, not only a new value: a value that arrived before the status turned ready still gets its block drawn.
    if (v.format !== "plain") {
      const f = this.focusInfo(v, this.doc(v)).last;
      if (f >= this.shown) this.shown = Math.ceil((f + 1) / PAGE) * PAGE;
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const v = this.value as ProseValue | undefined;
    if (!v?.focus || this.state().state !== "ready") return;
    const key = `${v.focus.from}:${v.focus.to}`;
    if (key === this.scrolledFor) return;
    const el = this.renderRoot.querySelector("[data-block][data-landing]");
    // A block in a hidden tab/host has no boxes: scrolling could not take effect, so a later update retries.
    if (el && el.getClientRects().length > 0) {
      this.scrolledFor = key;
      el.scrollIntoView?.({ block: "start" });
    }
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as ProseValue;
    const noteText = v.note ? sanitizeChatText(v.note, 500) : "";
    const note = noteText ? html`<p class="note">${noteText}</p>` : nothing;
    const cut = v.truncated ? html`<p class="cut">${say("lu.prose.cut")}</p>` : nothing;
    if (v.text === "") return html`${note}<p class="note">${say("lu.prose.empty")}</p>`;
    if (v.format === "plain") {
      const p = this.plain(v.text, v.focus);
      const mid = p.mid
        ? html`<mark data-block data-landing class="focus">${p.mid}</mark>`
        : nothing;
      return html`${note}<pre class="plain">${p.pre}${mid}${p.post}</pre>${v.truncated || p.cut ? html`<p class="cut">${say("lu.prose.cut")}</p>` : nothing}`;
    }
    const doc = this.doc(v);
    const { marked: focus, scroll } = this.focusInfo(v, doc);
    const blocks = doc.blocks.slice(0, this.shown);
    return html`${note}
      <div class="doc md">
        ${blocks.map(
          (block, i) =>
            html`<div data-block=${i} class=${focus.has(i) ? "focus" : ""} ?data-landing=${i === scroll}>${drawMarkdown({ blocks: [block], truncated: false }, { ref: noRef })}</div>`
        )}
      </div>
      ${
        doc.blocks.length > this.shown
          ? html`<button class="more" @click=${() => {
              this.shown += PAGE;
            }}>${say("lu.prose.more")}</button>`
          : nothing
      }
      ${doc.truncated ? html`<p class="cut">${say("lu.prose.cut")}</p>` : cut}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-prose": LuProse;
  }
}
