import { checkKindValue } from "@loom-ui/core";
import type { HandleStatus } from "@loom-ui/hydration";
import type { Widget, WidgetAction } from "@loom/blueprint-runtime";
import { LitElement, type TemplateResult, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { describeValue, errorStateText, loadingStateText, staleStateText } from "../a11y";
import { localized } from "../i18n";

export type WidgetState = "loading" | "pending" | "stale" | "error" | "ready";

/** What one (value, status) pair renders as, plus the finding that explains a non-ready state. */
export interface WidgetVerdict {
  readonly state: WidgetState;
  readonly finding?: string;
}

// ── The status matrix ─────────────────────────────────────────────────────────
//
// ONE decision table, and the terminal surface implements the SAME one in
// `@loom-ui/renderer-terminal`'s `status.ts` (`withStatus`). Both are pinned by an identical
// eight-row table-driven test (`statusMatrix.test.ts` in each package) so the two surfaces
// cannot drift into disagreeing about what a handle's state means:
//
//   1. status "error"                  → error, showing the STATUS finding. The value renderer
//                                        never runs: a live "provider timed out" is a more
//                                        specific diagnosis than anything the last-known value
//                                        could produce.
//   2. checkKindValue fails            → error, showing the CONTRACT finding.
//   3. status "stale" + value          → stale marker "~" + the normal rendering.
//      status "stale", no value        → stale marker, NO value renderer — "we know this is
//                                        stale AND we have nothing to show" is a third fact,
//                                        not a spinner.
//   4. status "pending" + value        → pending marker "⋯" + the normal rendering (the old
//                                        value is still the best answer while the next loads).
//      status "pending", no value      → loading.
//   5. value undefined                 → loading.
//   6. otherwise                       → ready.

/** Common shape: widget + value + status in, the matrix out. Subclasses implement `renderReady`. */
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

  // The verdict is a pure function of (value, status), and `render()`, `label()` and every
  // subclass that puts `label()` into its SVG ask for it — so it is computed ONCE per pair and
  // reused, rather than re-running `checkKindValue` (a Zod parse over the whole value, which for
  // a DataTable is O(rows×cols)) two or three times per update cycle.
  private verdictCache?: {
    value: unknown;
    status: HandleStatus | undefined;
    verdict: WidgetVerdict;
  };

  protected willUpdate(): void {
    // Warm the memo at the top of the cycle so the first reader is not the one paying for it.
    this.state();
  }

  protected state(): WidgetVerdict {
    const cached = this.verdictCache;
    if (cached !== undefined && cached.value === this.value && cached.status === this.status)
      return cached.verdict;
    const verdict = this.computeVerdict();
    this.verdictCache = { value: this.value, status: this.status, verdict };
    return verdict;
  }

  private computeVerdict(): WidgetVerdict {
    const status = this.status;
    if (status?.state === "error") return withFinding("error", status.finding?.message);
    const check = checkKindValue(this.kind, this.value);
    if (!check.ok) return { state: "error", finding: check.finding.message };
    if (status?.state === "stale") return withFinding("stale", status.finding?.message);
    if (status?.state === "pending" && this.value !== undefined)
      return withFinding("pending", status.finding?.message);
    if (this.value === undefined) return { state: "loading" };
    return { state: "ready" };
  }

  protected label(): string {
    const s = this.state();
    // "pending" is a load in progress over a value we already have: a screen reader should hear
    // the same "loading" it hears for a first load, not a state name of its own.
    if (s.state === "loading" || s.state === "pending") return loadingStateText(this.title_);
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
    // Stale with nothing to show: the marker, the reason, and an explicit "no value" — never
    // `renderReady()`, which would be handed `undefined` and read it as a value.
    if (s.state === "stale" && this.value === undefined)
      return html`<div
        role="group"
        aria-label=${this.label()}
        data-state="stale"
        class="state stale"
        title=${s.finding ?? ""}
      >
        <span class="stale-marker">~</span> ${this.title_}: ${s.finding ?? "stale"} — no value
      </div>`;
    const marker = s.state === "stale" ? "~" : s.state === "pending" ? "⋯" : undefined;
    return html`<div role="group" aria-label=${this.label()} data-state=${s.state}>
      ${
        marker !== undefined
          ? html`<span class="${s.state}-marker" title=${s.finding ?? ""}>${marker}</span>`
          : nothing
      }${this.renderReady()}
    </div>`;
  }
  protected abstract renderReady(): TemplateResult | typeof nothing;
}

function withFinding(state: WidgetState, message: string | undefined): WidgetVerdict {
  // `exactOptionalPropertyTypes`: an absent finding is an absent KEY, never `finding: undefined`.
  return message !== undefined ? { state, finding: message } : { state };
}
