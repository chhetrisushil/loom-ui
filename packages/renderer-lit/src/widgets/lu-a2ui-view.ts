import { LitElement, type TemplateResult, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type A2UIRender, type A2UIView, planView } from "../a2ui/plan";
import { localized, t } from "../i18n";

// ── The A2UI declarative interpreter ──────────────────────────────────────────
//
// Renders an A2UI component tree (adjacency list, root id "root") bound to a data
// model by JSON Pointer, using a small primitive vocabulary: Text, Badge, Column,
// Row, List, Button. This is how a component type with no bespoke Lit renderer —
// notably a user-registered one — is drawn generically from the same catalog the
// server publishes. No user code runs here (that path is the sandboxed iframe);
// this is pure declarative rendering of a trusted tree over data.
//
// All tree-walking decisions (the primitive switch, child/List resolution, cycle
// guarding, binding resolution) live in `planView` in `../a2ui/plan` and are unit-
// tested there; this element is a thin, deterministic map from that plan to DOM.
// A Button dispatches an `a2ui-action` event (composed, bubbling) carrying its
// `action` name and optional `context` — the inbound leg the studio/egress bridge
// turns into a Loom event.

@customElement("lu-a2ui-view")
export class LuA2UIView extends LitElement {
  /** The component tree to render (with its catalog id). */
  @property({ attribute: false }) view!: A2UIView;
  /** The data model bindings resolve against. */
  @property({ attribute: false }) data: unknown = {};

  constructor() {
    super();
    localized(this);
  }

  static styles = css`
    :host { display: block; height: 100%; box-sizing: border-box; }
    .col { display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; flex-direction: row; gap: 12px; align-items: center; flex-wrap: wrap; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .text { color: var(--gx-text, #e6edf3); font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
    .badge {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
      font-size: 12px; font-weight: 600; background: var(--gx-border, #30363d);
      color: var(--gx-text, #e6edf3);
    }
    .badge.ok { background: #14532d; color: #4ade80; }
    .badge.warning { background: #422006; color: #fbbf24; }
    .badge.critical, .badge.error { background: #450a0a; color: #f87171; }
    button.a2ui {
      font: inherit; cursor: pointer; padding: 6px 12px; border-radius: var(--gx-radius, 6px);
      border: 1px solid var(--gx-border, #30363d); background: var(--gx-accent, #2563eb);
      color: #fff; font-size: 13px; font-weight: 600;
    }
    button.a2ui:hover { filter: brightness(1.08); }
    .unknown { color: var(--gx-text-dim, #8b949e); font-size: 12px; font-style: italic; }
  `;

  render() {
    if (!this.view) return html`<div class="unknown">${t("empty view")}</div>`;
    return this.paint(planView(this.view, this.data));
  }

  private paint(node: A2UIRender): TemplateResult | typeof nothing {
    switch (node.kind) {
      case "text":
        return html`<span class="text">${node.text}</span>`;
      case "badge":
        return html`<span class="badge ${node.tone}">${node.label}</span>`;
      case "column":
        return html`<div class="col">${node.children.map((c) => this.paint(c))}</div>`;
      case "row":
        return html`<div class="row">${node.children.map((c) => this.paint(c))}</div>`;
      case "list":
        return html`<div class="list">${node.children.map((c) => this.paint(c))}</div>`;
      case "button":
        return html`<button
          class="a2ui"
          @click=${() => this.emitAction(node.action, node.context)}
        >${node.label}</button>`;
      case "unknown":
        // genUI interpolated `t("unknown component: {name}", { name })`; this
        // package's `t` is identity-only (no params), so the substitution is done
        // at the call site before handing the string to `t`.
        return html`<span class="unknown">${t(`unknown component: ${node.component}`)}</span>`;
      default:
        return nothing;
    }
  }

  private emitAction(action: string, context: unknown): void {
    if (!action) return;
    this.dispatchEvent(
      new CustomEvent("a2ui-action", {
        detail: { action, context: context ?? undefined },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-a2ui-view": LuA2UIView;
  }
}
