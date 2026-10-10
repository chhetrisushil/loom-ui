import {
  type FieldError,
  type FormField,
  type FormValues,
  MAX_INPUT_CHARS,
  SELECT_ACTION,
  SUBMIT_FORM_ACTION,
  SUBMIT_TEXT_ACTION,
  fieldsProblem,
  newSubmitKey,
  oneLineChatText,
  optionsProblem,
  validateFormValues,
  validateSelectValue,
  validateTextValue,
} from "@loom-ui/core/chat-ui";
import { type PropertyValues, type TemplateResult, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import { say } from "../say";
import { titleText } from "../title";
import { LuWidget } from "./base";
import { type DispatchResult, dispatch, failureText, inputStyles } from "./chatShared";

// ── The input widgets (U8): TextInput, FormInput, SelectInput ────────────────────────────────────
//
// Static (props only; a value reaching one is a contract error, as for a Note). Each emits ONE
// action per submit — SUBMIT_TEXT / SUBMIT_FORM / SELECT — which the renderer stamps with
// `viewedVersion` (U5) and the HOST re-validates (`acceptChatSubmit`): everything checked here is a
// courtesy to the user, checked in a browser the user controls.
//
// IDEMPOTENCY. A key is minted when the draft begins and travels with the submit. The draft is
// KEPT until the host answers `ok: true`: a failed send leaves the text and the key in place, so
// the user's retry carries the same key and cannot become a second turn. A success clears the draft
// and rotates the key. While a send is in flight the field is read-only (not disabled: that would
// drop keyboard focus), and a second submit is ignored.
//
// WHAT AN AUTHOR CANNOT DO: there is no `value` / `default` prop (see `chatPropFindings`), so no
// input can arrive pre-filled or pre-submitted by whoever composed the page.

const label = (w: LuWidget["widget"], fallback: string): string =>
  titleText((w.props as { label?: unknown }).label) ?? titleText(w.title) ?? fallback;
const textProp = (w: LuWidget["widget"], name: string, fallback: string): string =>
  titleText((w.props as Record<string, unknown>)[name]) ?? fallback;

/** An input has no bound value: with none, it draws itself; a value reaching it falls to the contract's error state. */
abstract class LuInput extends LuWidget {
  static styles = inputStyles;
  override render(): TemplateResult | typeof nothing {
    if (!this.widget) return nothing;
    if (this.value !== undefined) return super.render();
    return this.renderReady();
  }
}

type Phase = "idle" | "sending" | "sent" | DispatchResult | "invalid";

export class LuTextInput extends LuInput {
  readonly kind = "TextInput";
  @state() private draft = "";
  @state() private phase: Phase = "idle";
  @state() private problem = "";
  private key: string | undefined;

  private get multiline(): boolean {
    return (this.widget.props as { multiline?: unknown }).multiline === true;
  }
  private get max(): number {
    const m = (this.widget.props as { maxChars?: unknown }).maxChars;
    return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_INPUT_CHARS
      ? m
      : MAX_INPUT_CHARS;
  }

  private onInput = (e: Event): void => {
    this.draft = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    if (this.draft !== "") this.key ??= newSubmitKey();
    if (this.phase !== "sending") {
      this.phase = "idle";
      this.problem = "";
    }
  };

  private onKeydown = (e: KeyboardEvent): void => {
    // Multi-line: Enter is a newline; Ctrl/Cmd+Enter sends. Never while an IME is composing.
    if (e.key !== "Enter" || e.isComposing || !this.multiline) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      void this.submit();
    }
  };

  private onSubmit = (e: Event): void => {
    e.preventDefault();
    void this.submit();
  };

  private async submit(): Promise<void> {
    if (this.phase === "sending") return;
    const v = validateTextValue(this.draft, this.max);
    if (!v.ok) {
      this.phase = "invalid";
      this.problem = v.error === "too-long" ? say("lu.input.tooLong") : say("lu.chat.typeFirst");
      return;
    }
    this.key ??= newSubmitKey();
    const key = this.key;
    this.phase = "sending";
    const result = await dispatch(this.onAction, {
      type: SUBMIT_TEXT_ACTION,
      widgetId: this.widget.id,
      payload: { text: v.text, key },
    });
    if (result === "ok") {
      this.draft = "";
      this.key = undefined;
      this.phase = "sent";
      // Back to the field: the user is typing the next message.
      this.shadowRoot?.querySelector<HTMLElement>("[data-field]")?.focus();
    } else this.phase = result;
  }

  private statusText(): { text: string; error: boolean } {
    switch (this.phase) {
      case "sending":
        return { text: say("lu.chat.sending"), error: false };
      case "sent":
        return { text: say("lu.input.sent"), error: false };
      case "invalid":
        return { text: this.problem, error: true };
      case "idle":
        return { text: "", error: false };
      default:
        return { text: failureText(this.phase), error: true };
    }
  }

  protected renderReady(): TemplateResult {
    const name = label(this.widget, say("lu.input.message"));
    const placeholder = textProp(this.widget, "placeholder", "");
    const submitLabel = textProp(this.widget, "submitLabel", say("lu.chat.send"));
    const sending = this.phase === "sending";
    const s = this.statusText();
    const ph = placeholder === "" ? nothing : placeholder;
    return html`<form @submit=${this.onSubmit} data-text-input data-phase=${this.phase}>
      <label for="field">${name}</label>
      ${
        this.multiline
          ? html`<textarea id="field" data-field rows="3" maxlength=${this.max}
              placeholder=${ph} .value=${this.draft} ?readonly=${sending}
              aria-describedby="hint status" @input=${this.onInput} @keydown=${this.onKeydown}></textarea>
            <div class="hint" id="hint">${say("lu.input.hint")}</div>`
          : html`<input id="field" data-field type="text" maxlength=${this.max}
              placeholder=${ph} .value=${this.draft} ?readonly=${sending}
              autocomplete="off" aria-describedby="status" @input=${this.onInput} />`
      }
      <button type="submit" ?disabled=${sending}>${submitLabel}</button>
      <div class="status" id="status" role=${s.error ? "alert" : "status"} aria-live=${s.error ? "assertive" : "polite"} ?data-error=${s.error}>${s.text}</div>
    </form>`;
  }
}

// ── FormInput ─────────────────────────────────────────────────────────────────────────────────────

export class LuFormInput extends LuInput {
  readonly kind = "FormInput";
  @state() private raw: Record<string, string | boolean> = {};
  @state() private errors: Readonly<Record<string, FieldError>> = {};
  @state() private phase: Phase = "idle";
  private key: string | undefined;

  private get fields(): readonly FormField[] | undefined {
    const f = (this.widget.props as { fields?: unknown }).fields;
    return fieldsProblem(f) === undefined ? (f as readonly FormField[]) : undefined;
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    // A recomposed form is a different form: drafts for fields that no longer exist are dropped.
    if (changed.has("widget") && this.fields !== undefined) {
      const names = new Set(this.fields.map((f) => f.name));
      const kept = Object.entries(this.raw).filter(([k]) => names.has(k));
      if (kept.length !== Object.keys(this.raw).length) this.raw = Object.fromEntries(kept);
    }
  }

  private set(name: string, value: string | boolean): void {
    this.raw = { ...this.raw, [name]: value };
    this.key ??= newSubmitKey();
    if (this.phase !== "sending") this.phase = "idle";
    if (Object.hasOwn(this.errors, name)) {
      const { [name]: _gone, ...rest } = this.errors;
      this.errors = rest;
    }
  }

  private onSubmit = (e: Event): void => {
    e.preventDefault();
    void this.submit();
  };

  private async submit(): Promise<void> {
    const fields = this.fields;
    if (this.phase === "sending" || fields === undefined) return;
    const v = validateFormValues(fields, this.raw);
    if (!v.ok) {
      this.errors = v.errors;
      this.phase = "invalid";
      await this.updateComplete;
      // The first invalid field takes focus: a keyboard user lands on what to fix.
      const first = fields.find((f) => Object.hasOwn(v.errors, f.name));
      if (first !== undefined)
        this.shadowRoot
          ?.querySelector<HTMLElement>(`[data-name="${CSS.escape(first.name)}"]`)
          ?.focus();
      return;
    }
    this.key ??= newSubmitKey();
    const key = this.key;
    this.errors = {};
    this.phase = "sending";
    const result = await dispatch(this.onAction, {
      type: SUBMIT_FORM_ACTION,
      widgetId: this.widget.id,
      payload: { values: v.values as FormValues, key },
    });
    if (result === "ok") {
      this.raw = {};
      this.key = undefined;
      this.phase = "sent";
    } else this.phase = result;
  }

  private errorText(code: FieldError): string {
    switch (code) {
      case "required":
        return say("lu.input.error.required");
      case "too-long":
        return say("lu.input.error.tooLong");
      case "range":
        return say("lu.input.error.range");
      case "option":
        return say("lu.input.error.option");
      case "unknown":
        return say("lu.input.error.unknownField");
      default:
        return say("lu.input.error.invalid");
    }
  }

  private control(f: FormField, id: string, invalid: boolean, describedBy: string): TemplateResult {
    const val = this.raw[f.name];
    switch (f.type) {
      case "textarea":
        return html`<textarea id=${id} data-name=${f.name} rows="3" maxlength=${f.maxLength ?? MAX_INPUT_CHARS}
          aria-invalid=${invalid ? "true" : "false"} aria-required=${f.required === true ? "true" : "false"} aria-describedby=${describedBy}
          .value=${typeof val === "string" ? val : ""} ?readonly=${this.phase === "sending"}
          @input=${(e: Event) => this.set(f.name, (e.target as HTMLTextAreaElement).value)}></textarea>`;
      case "number":
        return html`<input id=${id} data-name=${f.name} type="number" inputmode="decimal"
          min=${f.min ?? nothing} max=${f.max ?? nothing}
          aria-invalid=${invalid ? "true" : "false"} aria-required=${f.required === true ? "true" : "false"} aria-describedby=${describedBy}
          .value=${typeof val === "string" ? val : ""} ?readonly=${this.phase === "sending"}
          @input=${(e: Event) => this.set(f.name, (e.target as HTMLInputElement).value)} />`;
      case "boolean":
        return html`<input id=${id} data-name=${f.name} type="checkbox"
          aria-invalid=${invalid ? "true" : "false"} aria-describedby=${describedBy}
          .checked=${val === true}
          @change=${(e: Event) => this.set(f.name, (e.target as HTMLInputElement).checked)} />`;
      case "select":
        return html`<select id=${id} data-name=${f.name}
          aria-invalid=${invalid ? "true" : "false"} aria-required=${f.required === true ? "true" : "false"} aria-describedby=${describedBy}
          .value=${typeof val === "string" ? val : ""}
          @change=${(e: Event) => this.set(f.name, (e.target as HTMLSelectElement).value)}>
          <option value="">${say("lu.input.chooseEllipsis")}</option>
          ${(f.options ?? []).map((o) => html`<option value=${o.value} ?selected=${val === o.value}>${oneLineChatText(o.label, 200)}</option>`)}
        </select>`;
      default:
        return html`<input id=${id} data-name=${f.name} type="text" maxlength=${f.maxLength ?? MAX_INPUT_CHARS}
          autocomplete="off" aria-invalid=${invalid ? "true" : "false"} aria-required=${f.required === true ? "true" : "false"} aria-describedby=${describedBy}
          .value=${typeof val === "string" ? val : ""} ?readonly=${this.phase === "sending"}
          @input=${(e: Event) => this.set(f.name, (e.target as HTMLInputElement).value)} />`;
    }
  }

  protected renderReady(): TemplateResult {
    const name = label(this.widget, say("lu.input.form"));
    const submitLabel = textProp(this.widget, "submitLabel", say("lu.input.submit"));
    const fields = this.fields;
    const sending = this.phase === "sending";
    const failed =
      this.phase === "failed" || this.phase === "stale" || this.phase === "unavailable";
    const text =
      this.phase === "sending"
        ? say("lu.chat.sending")
        : this.phase === "sent"
          ? say("lu.input.sent")
          : this.phase === "invalid"
            ? say("lu.input.fixFields")
            : failed
              ? failureText(this.phase as DispatchResult)
              : "";
    const isError = this.phase === "invalid" || failed;
    if (fields === undefined)
      return html`<div class="status" role="note" data-error>${say("lu.input.formUnavailable")}</div>`;
    return html`<form @submit=${this.onSubmit} novalidate role="group" aria-label=${name} data-form-input data-phase=${this.phase}>
      <div class="label">${name}</div>
      ${fields.map((f) => {
        const id = `f-${f.name}`;
        const err = Object.hasOwn(this.errors, f.name)
          ? (this.errors[f.name] as FieldError)
          : undefined;
        return html`<div class="row" data-field-row=${f.name}>
          <label for=${id}>${oneLineChatText(f.label, 200)}${f.required === true ? html`<span aria-hidden="true"> *</span>` : nothing}</label>
          ${this.control(f, id, err !== undefined, err !== undefined ? `${id}-err` : "")}
          ${err !== undefined ? html`<div class="error" id="${id}-err">${this.errorText(err)}</div>` : nothing}
        </div>`;
      })}
      <button type="submit" ?disabled=${sending}>${submitLabel}</button>
      <div class="status" role=${isError ? "alert" : "status"} aria-live=${isError ? "assertive" : "polite"} ?data-error=${isError}>${text}</div>
    </form>`;
  }
}

// ── SelectInput ───────────────────────────────────────────────────────────────────────────────────

export class LuSelectInput extends LuInput {
  readonly kind = "SelectInput";
  @state() private picked = "";
  @state() private phase: Phase = "idle";

  private get options() {
    const o = (this.widget.props as { options?: unknown }).options;
    return optionsProblem(o) === undefined
      ? (o as readonly { value: string; label: string }[])
      : undefined;
  }

  private onChange = async (e: Event): Promise<void> => {
    if (this.phase === "sending") return;
    const el = e.target as HTMLSelectElement;
    const options = this.options;
    const v = options === undefined ? undefined : validateSelectValue(options, el.value);
    if (v === undefined || !v.ok) {
      el.value = this.picked;
      return;
    }
    const previous = this.picked;
    this.picked = v.value;
    this.phase = "sending";
    const result = await dispatch(this.onAction, {
      type: SELECT_ACTION,
      widgetId: this.widget.id,
      // One selection = one submission = one key. A failed choice is undone, so it can be made again.
      payload: { value: v.value, key: newSubmitKey() },
    });
    if (result === "ok") this.phase = "sent";
    else {
      this.picked = previous;
      this.phase = result;
    }
  };

  protected renderReady(): TemplateResult {
    const name = label(this.widget, say("lu.input.choose"));
    const placeholder = textProp(this.widget, "placeholder", say("lu.input.chooseEllipsis"));
    const options = this.options;
    if (options === undefined)
      return html`<div class="status" role="note" data-error>${say("lu.input.choiceUnavailable")}</div>`;
    const failed =
      this.phase === "failed" || this.phase === "stale" || this.phase === "unavailable";
    const text =
      this.phase === "sending"
        ? say("lu.chat.sending")
        : this.phase === "sent"
          ? say("lu.input.sent")
          : failed
            ? failureText(this.phase as DispatchResult)
            : "";
    return html`<div data-select-input data-phase=${this.phase}>
      <label for="pick">${name}</label>
      <select id="pick" aria-describedby="status" .value=${this.picked} ?aria-busy=${this.phase === "sending"} @change=${this.onChange}>
        <option value="" disabled ?selected=${this.picked === ""}>${placeholder}</option>
        ${options.map((o) => html`<option value=${o.value} ?selected=${this.picked === o.value}>${oneLineChatText(o.label, 200)}</option>`)}
      </select>
      <div class="status" id="status" role=${failed ? "alert" : "status"} aria-live=${failed ? "assertive" : "polite"} ?data-error=${failed}>${text}</div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-text-input": LuTextInput;
    "lu-form-input": LuFormInput;
    "lu-select-input": LuSelectInput;
  }
}
