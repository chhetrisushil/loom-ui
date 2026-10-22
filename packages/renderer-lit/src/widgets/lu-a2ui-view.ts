import type { WidgetAction } from "@loom/blueprint-runtime";
import { LitElement, type TemplateResult, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { type A2UIRender, type A2UIView, planView } from "../a2ui/plan";
import { localized } from "../i18n";
import { say } from "../say";

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
// `action` name and optional `context` — the inbound leg the host/egress bridge
// turns into a Loom event.

export class LuA2UIView extends LitElement {
  /** The component tree to render (with its catalog id). */
  @property({ attribute: false }) view!: A2UIView;
  /** The data model bindings resolve against. */
  @property({ attribute: false }) data: unknown = {};
  /**
   * The host's action path (set by `lu-a2ui-widget` to the stamped `onAction`). A Button routes
   * here as `{ type: "A2UI_ACTION", payload: { action, context } }` — the model-authored `action`
   * name and `context` live ONLY under `payload`; provenance is stamped by the renderer.
   */
  @property({ attribute: false }) onAction?: (a: WidgetAction) => void;

  constructor() {
    super();
    localized(this);
  }

  static styles = css`
    :host { display: block; height: 100%; box-sizing: border-box; }
    .col { display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; flex-direction: row; gap: 12px; align-items: center; flex-wrap: wrap; }
    .sel {
      border-inline-start: 4px solid var(--lu-accent, #2563eb); padding-inline-start: 8px;
      background: color-mix(in srgb, var(--lu-accent, #2563eb) 14%, transparent);
      border-radius: var(--lu-radius, 6px);
    }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .text { color: var(--lu-text, #e6edf3); font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
    .badge {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
      font-size: 12px; font-weight: 600; background: var(--lu-border, #30363d);
      color: var(--lu-text, #e6edf3);
    }
    .badge.ok { background: #14532d; color: #4ade80; }
    .badge.warning { background: #422006; color: #fbbf24; }
    .badge.critical, .badge.error { background: #450a0a; color: #f87171; }
    button.a2ui {
      font: inherit; cursor: pointer; padding: 6px 12px; border-radius: var(--lu-radius, 6px);
      border: 1px solid var(--lu-border, #30363d); background: var(--lu-accent, #2563eb);
      color: #fff; font-size: 13px; font-weight: 600;
    }
    button.a2ui:hover { filter: brightness(1.08); }
    .unknown { color: var(--lu-text-dim, #8b949e); font-size: 12px; font-style: italic; }
  `;

  /** Tree path of the selected item last scrolled to; scroll only when it changes. */
  private scrolledTo: string | null = null;
  /** Tree path of the selected item in the current render (first one wins). */
  private selectedPath: string | null = null;

  render() {
    if (!this.view) return html`<div class="unknown">${say("lu.state.emptyView")}</div>`;
    this.selectedPath = null;
    return this.paint(planView(this.view, this.data), "0");
  }

  protected updated(): void {
    const key = this.selectedPath;
    if (key === this.scrolledTo) return;
    this.scrolledTo = key;
    if (key === null) return;
    const el = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-a2ui-path]")).find(
      (e) => e.dataset.a2uiPath === key
    );
    const reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
  }

  /** The attributes marking a selected container: `aria-current` (not colour-only) plus the highlight. */
  private selAttrs(node: { selected?: true }, path: string) {
    if (!node.selected) return { cls: "", cur: nothing, p: nothing };
    this.selectedPath ??= path;
    return { cls: " sel", cur: "true", p: path };
  }

  private paint(node: A2UIRender, path: string): TemplateResult | typeof nothing {
    switch (node.kind) {
      case "text":
        return html`<span class="text">${node.text}</span>`;
      case "badge":
        return html`<span class="badge ${node.tone}">${node.label}</span>`;
      case "column": {
        const s = this.selAttrs(node, path);
        return html`<div class="col${s.cls}" aria-current=${s.cur} data-a2ui-path=${s.p}>${node.children.map((c, i) => this.paint(c, `${path}.${i}`))}</div>`;
      }
      case "row": {
        const s = this.selAttrs(node, path);
        return html`<div class="row${s.cls}" aria-current=${s.cur} data-a2ui-path=${s.p}>${node.children.map((c, i) => this.paint(c, `${path}.${i}`))}</div>`;
      }
      case "list":
        return html`<div class="list">${node.children.map((c, i) => this.paint(c, `${path}.${i}`))}</div>`;
      case "button":
        return html`<button
          class="a2ui"
          @click=${() => this.emitAction(node.action, node.context)}
        >${node.label}</button>`;
      case "unknown":
        return html`<span class="unknown">${say("lu.state.unknownComponent", { name: node.component })}</span>`;
      default:
        return nothing;
    }
  }

  private emitAction(action: string, context: unknown): void {
    if (!action) return;
    // With `onAction` wired the host has the PROVENANCE-carrying path, and the provenance-free DOM
    // event is not fired (a host listening to both would act twice, once on an unverifiable copy).
    // Without it the DOM event still fires, unchanged, for hosts that have not migrated.
    if (this.onAction) {
      this.onAction({
        type: "A2UI_ACTION",
        widgetId: "",
        payload: { action, context: context ?? undefined },
      });
      return;
    }
    // DEPRECATED: carries NO provenance; wire `onAction` instead.
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
