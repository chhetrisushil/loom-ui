import { type ContractRegistry, checkKindValue, hasKindContract } from "@loom-ui/core/browser";
import type { BindingStatus, Widget, WidgetAction } from "@loom/blueprint-runtime";
import { LitElement, type PropertyValues, type TemplateResult, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import {
  describeValue,
  emptyStateText,
  errorStateText,
  loadingStateText,
  staleStateText,
} from "../a11y";
import { localized } from "../i18n";
import { titleText } from "../title";

/**
 * Who draws the widget's title. `"widget"` (default) — the widget prints its own title in its
 * body. `"host"` — the embedding app draws its own chrome (title bar, frame) around the widget,
 * so the body carries NO visible title and the host's is the only one. The accessible name
 * (`aria-label`, the screen-reader caption) still names the widget either way: chrome is a
 * visual choice, not a reason to leave an assistive-technology reader without a name.
 */
export type TitleChrome = "widget" | "host";

export type WidgetState = "loading" | "pending" | "stale" | "error" | "empty" | "ready";

/** What one (value, status) pair renders as, plus the finding that explains a non-ready state. */
export interface WidgetVerdict {
  readonly state: WidgetState;
  readonly finding?: string;
}

// ── The status matrix ─────────────────────────────────────────────────────────
//
// ONE decision table, over the `BindingStatus` loom resolves from the widget's binding, and the
// terminal surface implements the SAME one in `@loom-ui/renderer-terminal`. Both are pinned by
// an identical ten-row table-driven test (`statusMatrix.test.ts` in each package) so the two
// surfaces cannot drift into disagreeing about what a binding's state means:
//
//   1. status "error"                  → error, showing the STATUS finding. The value renderer
//                                        never runs: a live "provider timed out" is a more
//                                        specific diagnosis than anything the last-known value
//                                        could produce.
//   2. status "empty"                  → "No data" (loom ADR 0100): the upstream answered with no
//                                        such row. The value renderer never runs and a value
//                                        beside it is ignored; the contract is not checked —
//                                        there is no value to check.
//   3. checkKindValue fails            → error, showing the CONTRACT finding.
//   4. status "stale" + value          → stale marker "~" + the normal rendering.
//      status "stale", no value        → stale marker, NO value renderer — "we know this is
//                                        stale AND we have nothing to show" is a third fact,
//                                        not a spinner.
//   5. status "pending" + value        → pending marker "⋯" + the normal rendering (the old
//                                        value is still the best answer while the next loads).
//      status "pending", no value      → loading.
//   6. value undefined                 → loading.
//   7. otherwise                       → ready.

/** Common shape: widget + value + status in, the matrix out. Subclasses implement `renderReady`. */
export abstract class LuWidget extends LitElement {
  @property({ attribute: false }) widget!: Widget;
  @property({ attribute: false }) value: unknown = undefined;
  @property({ attribute: false }) status?: BindingStatus;
  @property({ attribute: false }) onAction?: (a: WidgetAction) => void;
  /**
   * The host's value contracts (a catalogue's `valueContracts`) for kinds of its own. A widget of
   * a host kind with no contract here still renders, but marked `data-unchecked` — never as if it
   * had been checked.
   */
  @property({ attribute: false }) contracts?: ContractRegistry;
  /** Who draws the title — see {@link TitleChrome}. Default `"widget"`. */
  @property({ reflect: true }) chrome: TitleChrome = "widget";

  abstract readonly kind: string;
  constructor() {
    super();
    localized(this);
  }
  protected get title_(): string {
    // A non-empty string is a title; `""` (or a stray non-string) is none, so the kind stands in
    // — one rule for every widget (`titleText`), the same one the terminal renderer applies.
    return titleText(this.widget?.title) ?? this.widget?.kind ?? "";
  }

  /** The visible title text, or `undefined` when the host draws it (`chrome="host"`). */
  protected get visibleTitle(): string | undefined {
    return this.chrome === "host" ? undefined : this.title_;
  }

  /** `Title: text` in the widget's own chrome, just `text` when the host owns the title. */
  protected titled(text: string): string {
    const title = this.visibleTitle;
    return title === undefined ? text : `${title}: ${text}`;
  }

  /**
   * The semantic type this widget stands for, when that is NOT the kind on screen: a `source`
   * with a degrade chain means the catalogue could only serve a Trend as a MetricCard. A
   * sighted reader sees the chain in `data-degraded`; a screen-reader reader must hear it too,
   * because "p99: 7" alone hides that the shape of the answer was narrowed. An undegraded
   * widget says nothing — its `source.type` only repeats `kind`.
   */
  protected get sourceLabel(): string | undefined {
    const source = this.widget?.source;
    if (!source?.degradedFrom?.length) return undefined;
    return `${source.type}, shown as ${this.widget.kind}`;
  }

  /**
   * The degrade chain as `Type@version`, outermost first — absent when nothing was degraded.
   * The separator is loom's ` › ` (U+203A), byte-identical to what its React `WidgetFrame` puts
   * in `data-degraded` and what its terminal renderer prints after "degraded from": the chain is
   * one fact about a widget, and a page (or a test, or a person reading two surfaces side by
   * side) must not have to know which renderer drew it to read it.
   */
  private get degradedChain(): string | undefined {
    const chain = this.widget?.source?.degradedFrom;
    if (!chain?.length) return undefined;
    return chain.map((s) => `${s.type}@${s.version}`).join(" › ");
  }

  // The verdict is a pure function of (value, status), and `render()`, `label()` and every
  // subclass that puts `label()` into its SVG ask for it — so it is computed ONCE per pair and
  // reused, rather than re-running `checkKindValue` (a Zod parse over the whole value, which for
  // a DataTable is O(rows×cols)) two or three times per update cycle.
  private verdictCache?: {
    value: unknown;
    status: BindingStatus | undefined;
    contracts: ContractRegistry | undefined;
    verdict: WidgetVerdict;
  };

  protected willUpdate(changed: PropertyValues): void {
    // Warm the memo at the top of the cycle so the first reader is not the one paying for it.
    this.state();
    // The chain belongs on the HOST, not inside the shadow root: it describes the element a
    // page styles and queries, and it survives every state the matrix renders. It is a function
    // of `widget` alone, so a value/status tick never rewrites the attribute.
    if (!changed.has("widget")) return;
    const chain = this.degradedChain;
    if (chain === undefined) this.removeAttribute("data-degraded");
    else this.setAttribute("data-degraded", chain);
  }

  protected state(): WidgetVerdict {
    const cached = this.verdictCache;
    if (
      cached !== undefined &&
      cached.value === this.value &&
      cached.status === this.status &&
      cached.contracts === this.contracts
    )
      return cached.verdict;
    const verdict = this.computeVerdict();
    this.verdictCache = {
      value: this.value,
      status: this.status,
      contracts: this.contracts,
      verdict,
    };
    return verdict;
  }

  private computeVerdict(): WidgetVerdict {
    const status = this.status;
    if (status?.state === "error") return withFinding("error", status.finding?.message);
    if (status?.state === "empty") return withFinding("empty", status.finding?.message);
    const check = checkKindValue(this.kind, this.value, this.contracts);
    if (!check.ok) return { state: "error", finding: check.finding.message };
    if (status?.state === "stale") return withFinding("stale", status.finding?.message);
    if (status?.state === "pending" && this.value !== undefined)
      return withFinding("pending", status.finding?.message);
    if (this.value === undefined) return { state: "loading" };
    return { state: "ready" };
  }

  protected label(): string {
    const source = this.sourceLabel;
    const base = this.stateLabel();
    return source === undefined ? base : `${source}: ${base}`;
  }

  private stateLabel(): string {
    const s = this.state();
    // "pending" is a load in progress over a value we already have: a screen reader should hear
    // the same "loading" it hears for a first load, not a state name of its own.
    if (s.state === "loading" || s.state === "pending") return loadingStateText(this.title_);
    if (s.state === "error") return errorStateText(this.title_);
    if (s.state === "stale") return staleStateText(this.title_);
    if (s.state === "empty") return `${this.title_}: ${emptyStateText()}`;
    return describeValue(this.kind, this.value, this.title_, this.widget?.props, this.contracts);
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
        ${this.titled(s.finding ?? "error")}
      </div>`;
    // "No data" is a result, not a failure: a POLITE live region (`role="status"`), exactly as
    // loom's React marker (ADR 0100 D3) — never `role="alert"`, and never the value renderer.
    if (s.state === "empty")
      return html`<div
        role="status"
        aria-label=${this.label()}
        data-state="empty"
        class="state empty"
        title=${s.finding ?? ""}
      >
        ${this.titled(emptyStateText())}
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
        <span class="stale-marker">~</span> ${this.titled(s.finding ?? "stale")} — no value
      </div>`;
    const marker = s.state === "stale" ? "~" : s.state === "pending" ? "⋯" : undefined;
    const unchecked = !hasKindContract(this.kind, this.contracts);
    return html`<div role="group" aria-label=${this.label()} data-state=${s.state} ?data-unchecked=${unchecked}>
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
