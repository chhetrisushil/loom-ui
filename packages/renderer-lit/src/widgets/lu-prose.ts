import type { ProseValue } from "@loom-ui/core/browser";
import { type MdDocument, parseMarkdownDocument, parseOrgDocument } from "@loom-ui/core/chat-ui";
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
  private scrolledFor = "";

  private doc(v: ProseValue): MdDocument {
    if (this.parsed?.format === v.format && this.parsed.text === v.text) return this.parsed.doc;
    const doc = v.format === "org" ? parseOrgDocument(v.text) : parseMarkdownDocument(v.text);
    this.parsed = { format: v.format, text: v.text, doc };
    return doc;
  }

  private focusIndex(v: ProseValue, doc: MdDocument): number {
    if (!v.focus) return -1;
    const { from, to } = v.focus;
    return doc.ranges.findIndex((r) => r.from < Math.max(to, from + 1) && r.to > from);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const v = this.value as ProseValue | undefined;
    if (changed.has("value") && v && this.state().state === "ready" && v.format !== "plain") {
      const f = this.focusIndex(v, this.doc(v));
      if (f >= this.shown) this.shown = Math.ceil((f + 1) / PAGE) * PAGE;
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const v = this.value as ProseValue | undefined;
    if (!v?.focus || this.state().state !== "ready") return;
    const key = `${v.focus.from}:${v.focus.to}:${v.text.length}`;
    if (key === this.scrolledFor) return;
    const el = this.renderRoot.querySelector("[data-block].focus");
    if (el) {
      this.scrolledFor = key;
      el.scrollIntoView?.({ block: "start" });
    }
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as ProseValue;
    const note = v.note ? html`<p class="note">${v.note}</p>` : nothing;
    const cut = v.truncated ? html`<p class="cut">${say("lu.prose.cut")}</p>` : nothing;
    if (v.text === "") return html`${note}<p class="note">${say("lu.prose.empty")}</p>`;
    if (v.format === "plain") return html`${note}<pre class="plain">${v.text}</pre>${cut}`;
    const doc = this.doc(v);
    const focus = this.focusIndex(v, doc);
    const blocks = doc.blocks.slice(0, this.shown);
    return html`${note}
      <div class="doc md">
        ${blocks.map(
          (block, i) =>
            html`<div data-block=${i} class=${i === focus ? "focus" : ""}>${drawMarkdown({ blocks: [block], truncated: false }, { ref: noRef })}</div>`
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
