import {
  MAX_MULTI_SELECTED,
  type MultiSelectOption,
  type MultiSelectValue,
  SELECT_MANY_ACTION,
  multiSelectValueIssues,
  newSubmitKey,
  oneLineChatText,
} from "@loom-ui/core/chat-ui";
import { type TemplateResult, css, html, nothing } from "lit";
import { state } from "lit/decorators.js";

import { say } from "../say";
import { titleText } from "../title";
import { LuWidget } from "./base";
import { type DispatchResult, dispatch, failureText, inputStyles } from "./chatShared";

// ── MultiSelectInput (U8): a set of choices, bound ────────────────────────────────────────────────
//
// The options and the current choice are the BOUND value (`MultiSelectValue`), checked by the kind
// contract before this widget sees them, so the base class draws loading / error / stale as for any
// data widget. Each change emits ONE `SELECT_MANY { values, key }` carrying the WHOLE new choice and a
// fresh key; the host re-checks every value against what it published (`optionsOf`). Nothing is shown
// optimistically: the chips are always the bound value, and the control is busy until the host
// answers. Labels, hints and the note are untrusted text, drawn as one line.

type Phase = "idle" | "sending" | "sent" | DispatchResult;

const MAX_SHOWN = 50;

export class LuMultiSelectInput extends LuWidget {
  static styles = [
    inputStyles,
    css`
      .chips { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; margin: 0; padding: 0; align-items: center; }
      [data-chip] { display: inline-flex; align-items: center; gap: 2px; border: 1px solid currentColor; border-radius: 999px; padding: 0 2px 0 8px; }
      [data-chip] button { border: 0; background: none; cursor: pointer; padding: 0 6px; font: inherit; }
      [data-empty] { font-style: italic; }
      [role="listbox"] { list-style: none; margin: 4px 0 0; padding: 0; max-height: 240px; overflow: auto; border: 1px solid currentColor; }
      [role="option"] { padding: 4px 8px; cursor: pointer; }
      [role="option"][aria-selected="true"] { outline: 2px solid currentColor; outline-offset: -2px; }
      [data-note] { margin: 4px 0 0; font-size: 0.9em; }
    `,
  ];
  readonly kind = "MultiSelectInput";
  @state() private phase: Phase = "idle";
  @state() private open = false;
  @state() private query = "";
  @state() private active = 0;

  private get model(): MultiSelectValue | undefined {
    return multiSelectValueIssues(this.value).length === 0
      ? (this.value as MultiSelectValue)
      : undefined;
  }
  private get max(): number {
    const m = (this.widget.props as { maxSelected?: unknown }).maxSelected;
    return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MULTI_SELECTED
      ? m
      : MAX_MULTI_SELECTED;
  }
  private text(name: string, fallback: string): string {
    return titleText((this.widget.props as Record<string, unknown>)[name]) ?? fallback;
  }
  private static optionText(o: MultiSelectOption): string {
    const label = oneLineChatText(o.label, 200);
    return o.hint === undefined ? label : `${label} (${oneLineChatText(o.hint, 40)})`;
  }
  /** Unchosen options whose label contains the query (case-insensitive), at most MAX_SHOWN. */
  private get candidates(): readonly MultiSelectOption[] {
    const m = this.model;
    if (m === undefined) return [];
    const chosen = new Set(m.selected);
    const q = this.query.trim().toLowerCase();
    return m.options
      .filter((o) => !chosen.has(o.value) && (q === "" || o.label.toLowerCase().includes(q)))
      .slice(0, MAX_SHOWN);
  }

  private async send(values: readonly string[]): Promise<void> {
    if (this.phase === "sending") return;
    this.phase = "sending";
    const result = await dispatch(this.onAction, {
      type: SELECT_MANY_ACTION,
      widgetId: this.widget.id,
      payload: { values: [...values], key: newSubmitKey() },
    });
    this.phase = result === "ok" ? "sent" : result;
  }
  private add(value: string): void {
    const m = this.model;
    if (m === undefined || m.selected.includes(value) || m.selected.length >= this.max) return;
    this.query = "";
    this.active = 0;
    void this.send([...m.selected, value]);
  }
  private removeChoice(value: string): void {
    const m = this.model;
    if (m !== undefined) void this.send(m.selected.filter((v) => v !== value));
  }
  private toggle = async (): Promise<void> => {
    this.open = !this.open;
    this.query = "";
    this.active = 0;
    if (!this.open) return;
    await this.updateComplete;
    this.shadowRoot?.querySelector<HTMLInputElement>("input[data-search]")?.focus();
  };
  private onInput = (e: Event): void => {
    this.query = (e.target as HTMLInputElement).value;
    this.active = 0;
  };
  private onKey = (e: KeyboardEvent): void => {
    const list = this.candidates;
    if (e.key === "ArrowDown") this.active = Math.min(list.length - 1, this.active + 1);
    else if (e.key === "ArrowUp") this.active = Math.max(0, this.active - 1);
    else if (e.key === "Enter") {
      const o = list[this.active];
      if (o !== undefined) this.add(o.value);
    } else if (e.key === "Escape") {
      this.open = false;
      this.shadowRoot?.querySelector<HTMLButtonElement>("[data-add]")?.focus();
    } else if (e.key === "Backspace" && this.query === "") {
      const last = this.model?.selected.at(-1);
      if (last !== undefined) this.removeChoice(last);
    } else return;
    e.preventDefault();
  };

  protected renderReady(): TemplateResult | typeof nothing {
    const m = this.model;
    if (m === undefined) return nothing;
    const byValue = new Map(m.options.map((o) => [o.value, o]));
    const busy = this.phase === "sending";
    const failed =
      this.phase === "failed" || this.phase === "stale" || this.phase === "unavailable";
    const list = this.open ? this.candidates : [];
    const status = busy
      ? say("lu.chat.sending")
      : failed
        ? failureText(this.phase as DispatchResult)
        : "";
    const activeId = list[this.active] === undefined ? nothing : `opt-${this.active}`;
    return html`<div data-multi-select data-phase=${this.phase} role="group" aria-labelledby="name" aria-describedby="status">
      <span id="name">${this.text("label", say("lu.input.choose"))}</span>
      <ul class="chips" part="chips">
        ${
          m.selected.length === 0
            ? html`<li data-empty>${this.text("emptyLabel", say("lu.input.none"))}</li>`
            : m.selected.map((v) => {
                const t = LuMultiSelectInput.optionText(byValue.get(v) as MultiSelectOption);
                return html`<li data-chip=${v}><span>${t}</span><button type="button" aria-label=${`${say("lu.input.remove")} ${t}`} ?disabled=${busy} @click=${() => this.removeChoice(v)}>×</button></li>`;
              })
        }
        <li><button type="button" data-add aria-expanded=${String(this.open)} ?disabled=${busy || m.selected.length >= this.max} @click=${this.toggle}>${say("lu.input.add")}</button></li>
      </ul>
      ${
        this.open
          ? html`<input data-search role="combobox" aria-label=${say("lu.input.search")} aria-expanded="true" aria-controls="list" aria-autocomplete="list" aria-activedescendant=${activeId} placeholder=${this.text("placeholder", say("lu.input.chooseEllipsis"))} .value=${this.query} ?readonly=${busy} @input=${this.onInput} @keydown=${this.onKey} />
            <ul id="list" role="listbox">${
              list.length === 0
                ? html`<li role="option" aria-disabled="true">${say("lu.input.noMatches")}</li>`
                : list.map(
                    (o, i) =>
                      html`<li id=${`opt-${i}`} role="option" aria-selected=${String(i === this.active)} data-option=${o.value} @mousedown=${(
                        e: Event
                      ) => {
                        e.preventDefault(); // keep focus in the search
                        this.add(o.value);
                      }}>${LuMultiSelectInput.optionText(o)}</li>`
                  )
            }</ul>`
          : nothing
      }
      ${m.note === undefined ? nothing : html`<p data-note>${oneLineChatText(m.note, 200)}</p>`}
      <div class="status" id="status" role=${failed ? "alert" : "status"} aria-live=${failed ? "assertive" : "polite"} ?data-error=${failed}>${status}</div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-multi-select-input": LuMultiSelectInput;
  }
}
