import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { localized, t } from "../i18n";

export type TimeRangePreset = "24h" | "7d" | "30d" | "90d" | "12m";
export interface TimeRange {
  preset?: TimeRangePreset;
  from?: string;
  to?: string;
}

// A dashboard-level time-range control. Presets cover the common windows; the
// Custom option reveals two date inputs. Emits `lu-time-range` with a
// TimeRange; the studio re-hydrates every time-bound widget for the new window.

// Labels are resolved per render, not once at module load: t() must run after the
// locale is active, and again after the user switches it.
const presets = (): { key: TimeRangePreset; label: string }[] => [
  { key: "24h", label: t("24h") },
  { key: "7d", label: t("7d") },
  { key: "30d", label: t("30d") },
  { key: "90d", label: t("90d") },
  { key: "12m", label: t("12m") },
];

@customElement("lu-time-range-picker")
export class LuTimeRangePicker extends LitElement {
  @property({ attribute: false }) value?: TimeRange;
  @state() private customOpen = false;
  constructor() {
    super();
    localized(this);
  }

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .icon {
      color: var(--lu-text-dim, #8b949e);
      font-size: 12px;
    }
    .seg {
      display: inline-flex;
      background: var(--lu-panel, #161b22);
      border: 1px solid var(--lu-border, #30363d);
      border-radius: 8px;
      overflow: hidden;
    }
    button {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--lu-text-dim, #8b949e);
      font: inherit;
      font-size: 12px;
      padding: 4px 9px;
      cursor: pointer;
      border-inline-start: 1px solid var(--lu-border, #30363d);
    }
    button:first-child {
      border-inline-start: none;
    }
    button:hover {
      color: var(--lu-text, #e6edf3);
      background: rgba(99, 102, 241, 0.08);
    }
    button.active {
      color: #fff;
      background: var(--lu-accent, #6366f1);
    }
    .custom {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--lu-text-dim, #8b949e);
    }
    input[type="date"] {
      background: var(--lu-panel, #161b22);
      color: var(--lu-text, #e6edf3);
      border: 1px solid var(--lu-border, #30363d);
      border-radius: 6px;
      padding: 3px 6px;
      font: inherit;
      font-size: 12px;
      color-scheme: dark;
    }
  `;

  private get activePreset(): TimeRangePreset | undefined {
    return this.value?.from ? undefined : this.value?.preset;
  }
  private get isCustom(): boolean {
    return Boolean(this.value?.from && this.value?.to);
  }

  render() {
    const active = this.activePreset;
    return html`
      <span class="icon" title=${t("Time range")}>🕒</span>
      <div class="seg">
        ${presets().map(
          (p) => html`<button
            class=${active === p.key ? "active" : ""}
            data-preset=${p.key}
            @click=${() => this.pickPreset(p.key)}
          >
            ${p.label}
          </button>`
        )}
        <button class=${this.isCustom ? "active" : ""} @click=${this.toggleCustom}>
          ${t("Custom")}
        </button>
      </div>
      ${
        this.customOpen
          ? html`<span class="custom">
            <input type="date" .value=${this.dateStr(this.value?.from)} @change=${this.onFrom} aria-label=${t("From")} />
            <span>→</span>
            <input type="date" .value=${this.dateStr(this.value?.to)} @change=${this.onToDate} aria-label=${t("To")} />
          </span>`
          : nothing
      }
    `;
  }

  private dateStr(iso?: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  private toggleCustom = (): void => {
    this.customOpen = !this.customOpen;
  };

  private pickPreset(preset: TimeRangePreset): void {
    this.customOpen = false;
    this.emit({ preset });
  }

  private pendingFrom?: string;
  private pendingTo?: string;

  private onFrom = (e: Event): void => {
    this.pendingFrom = (e.target as HTMLInputElement).value;
    this.tryCustom();
  };
  private onToDate = (e: Event): void => {
    this.pendingTo = (e.target as HTMLInputElement).value;
    this.tryCustom();
  };
  private tryCustom(): void {
    const from = this.pendingFrom ?? this.dateStr(this.value?.from);
    const to = this.pendingTo ?? this.dateStr(this.value?.to);
    if (!from || !to) return;
    this.emit({
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: new Date(`${to}T23:59:59`).toISOString(),
    });
  }

  private emit(range: TimeRange): void {
    this.dispatchEvent(
      new CustomEvent<TimeRange>("lu-time-range", {
        detail: range,
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-time-range-picker": LuTimeRangePicker;
  }
}
