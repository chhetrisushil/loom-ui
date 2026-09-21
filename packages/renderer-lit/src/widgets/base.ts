import { checkKindValue } from "@loom-ui/core";
import type { HandleStatus } from "@loom-ui/hydration";
import type { Widget, WidgetAction } from "@loom/blueprint-runtime";
import { LitElement, type TemplateResult, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { describeValue, errorStateText, loadingStateText, staleStateText } from "../a11y";
import { localized } from "../i18n";

export type WidgetState = "loading" | "stale" | "error" | "ready";

/** Common shape: widget + value + status in, four states out. Subclasses implement `renderReady`. */
export abstract class LuWidget extends LitElement {
  @property({ attribute: false }) widget!: Widget;
  @property({ attribute: false }) value: unknown = undefined;
  @property({ attribute: false }) status?: HandleStatus;
  @property({ attribute: false }) onAction?: (a: WidgetAction) => void;

  abstract readonly kind: string;
  constructor() {
    super();
    localized(this);
  }
  protected get title_(): string {
    return this.widget?.title ?? this.widget?.kind ?? "";
  }
  protected state(): { state: WidgetState; finding?: string } {
    if (this.status?.state === "error") {
      const finding = this.status.finding?.message;
      return finding !== undefined ? { state: "error", finding } : { state: "error" };
    }
    const check = checkKindValue(this.kind, this.value);
    if (!check.ok) return { state: "error", finding: check.finding.message };
    if (this.value === undefined) return { state: "loading" };
    if (this.status?.state === "stale") {
      const finding = this.status.finding?.message;
      return finding !== undefined ? { state: "stale", finding } : { state: "stale" };
    }
    return { state: "ready" };
  }
  protected label(): string {
    const s = this.state();
    if (s.state === "loading") return loadingStateText(this.title_);
    if (s.state === "error") return errorStateText(this.title_);
    if (s.state === "stale") return staleStateText(this.title_);
    return describeValue(this.kind, this.value, this.title_);
  }
  render(): TemplateResult | typeof nothing {
    const s = this.state();
    if (s.state === "loading")
      return html`<div role="group" aria-label=${this.label()} data-state="loading" class="state">…</div>`;
    if (s.state === "error")
      return html`<div
        role="group"
        aria-label=${this.label()}
        data-state="error"
        class="state error"
        title=${s.finding ?? ""}
      >
        ${this.title_}: ${s.finding ?? "error"}
      </div>`;
    return html`<div role="group" aria-label=${this.label()} data-state=${s.state}>
      ${s.state === "stale" ? html`<span class="stale-marker" title=${s.finding ?? ""}>~</span>` : nothing}${this.renderReady()}
    </div>`;
  }
  protected abstract renderReady(): TemplateResult | typeof nothing;
}
