// ── Input specs and their ONE validator (U8) ────────────────────────────────────────────────────
//
// A form / select / text input is described by a small, closed SPEC, carried as the input node's
// props. The same spec is read in two places that must agree and must not trust each other:
//  - the widget (in the user's browser): to draw the controls and to refuse an obviously bad value
//    early, as a courtesy;
//  - the HOST (`acceptChatSubmit`): to re-validate what actually arrived. The action is client
//    input: everything the widget checked was checked in a browser the user controls.
// Both call {@link validateFormValues} / {@link validateSelectValue} / {@link validateTextValue},
// so they cannot disagree about what a valid value is.
//
// The spec language is deliberately small: no regular expressions (an author-supplied pattern is a
// ReDoS), no callbacks, no cross-field rules, no defaults. A planner may SHAPE a form (its field
// names, types and bounds); it can never PREFILL or SUBMIT a value.

import { sanitizeChatText } from "./chatText";

export const MAX_INPUT_CHARS = 32_000;
export const MAX_FORM_FIELDS = 32;
export const MAX_OPTIONS = 64;
export const MAX_OPTION_VALUE = 128;
export const MAX_LABEL = 200;
export const MAX_FIELD_NAME = 64;

export type FormFieldType = "text" | "textarea" | "number" | "boolean" | "select";
const FIELD_TYPES: readonly string[] = ["text", "textarea", "number", "boolean", "select"];

export interface InputOption {
  readonly value: string;
  readonly label: string;
}
export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly type: FormFieldType;
  readonly required?: boolean;
  /** `select` only. */
  readonly options?: readonly InputOption[];
  /** `text` / `textarea`: the longest accepted value. `number`: ignored. */
  readonly maxLength?: number;
  /** `number` only. */
  readonly min?: number;
  readonly max?: number;
}
export type FormScalar = string | number | boolean;
export type FormValues = Readonly<Record<string, FormScalar>>;

/** The validation code for one field. Fixed vocabulary: the words are the renderer's. */
export type FieldError = "required" | "type" | "too-long" | "range" | "option" | "unknown";

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const hasControl = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || (c >= 127 && c < 160)) return true;
  }
  return false;
};

/** Why `options` is not a valid option list, value-free; undefined when it is. */
export function optionsProblem(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS)
    return `options is a list of 1 to ${MAX_OPTIONS}`;
  const seen = new Set<string>();
  for (const o of options) {
    if (typeof o !== "object" || o === null || Array.isArray(o))
      return "an option is { value, label }";
    const { value, label } = o as { value?: unknown; label?: unknown };
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_OPTION_VALUE ||
      hasControl(value)
    )
      return "an option value is short text without control characters";
    if (typeof label !== "string" || label.length === 0 || label.length > MAX_LABEL)
      return "an option label is short text";
    if (Object.keys(o).some((k) => k !== "value" && k !== "label")) return "unexpected field";
    if (seen.has(value)) return "option values are unique";
    seen.add(value);
  }
  return undefined;
}

/** Why `fields` is not a valid field list, value-free; undefined when it is. */
export function fieldsProblem(fields: unknown): string | undefined {
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FORM_FIELDS)
    return `fields is a list of 1 to ${MAX_FORM_FIELDS}`;
  const names = new Set<string>();
  for (const f of fields) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) return "a field is an object";
    const r = f as Record<string, unknown>;
    if (typeof r.name !== "string" || !NAME.test(r.name))
      return `a field name is a letter then letters, digits or _ (at most ${MAX_FIELD_NAME})`;
    if (names.has(r.name)) return "field names are unique";
    names.add(r.name);
    if (typeof r.label !== "string" || r.label.length === 0 || r.label.length > MAX_LABEL)
      return "a field label is short text";
    if (typeof r.type !== "string" || !FIELD_TYPES.includes(r.type))
      return "a field type is text, textarea, number, boolean or select";
    if (r.required !== undefined && typeof r.required !== "boolean")
      return "required is true or false";
    if (r.type === "select") {
      const p = optionsProblem(r.options);
      if (p !== undefined) return p;
    } else if (r.options !== undefined) return "only a select field takes options";
    for (const k of ["maxLength", "min", "max"] as const) {
      const v = r[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) return `${k} is a number`;
      if (k === "maxLength" && (!Number.isInteger(v) || v < 1 || v > MAX_INPUT_CHARS))
        return `maxLength is an integer from 1 to ${MAX_INPUT_CHARS}`;
      if (k === "maxLength" && r.type !== "text" && r.type !== "textarea")
        return "only a text field takes maxLength";
      if (k !== "maxLength" && r.type !== "number") return `only a number field takes ${k}`;
    }
    if (
      typeof r.min === "number" &&
      typeof r.max === "number" &&
      (r.min as number) > (r.max as number)
    )
      return "min must not exceed max";
    if (
      Object.keys(r).some(
        (k) =>
          !["name", "label", "type", "required", "options", "maxLength", "min", "max"].includes(k)
      )
    )
      return "unexpected field";
  }
  return undefined;
}

/** Narrow already-checked props to fields. Only call after {@link fieldsProblem} returned undefined. */
export const asFields = (fields: unknown): readonly FormField[] => fields as readonly FormField[];

export type FormValidation =
  | { readonly ok: true; readonly values: FormValues }
  | { readonly ok: false; readonly errors: Readonly<Record<string, FieldError>> };

/**
 * Validate `raw` (client input: any value) against `fields`. Every field is checked; an unknown
 * name is an error under that name (a form accepts only the fields it declares); a missing optional
 * field is simply absent from the result. Text values are sanitised exactly as chat text is. The
 * result is a NEW plain object built from declared names only: nothing from `raw` is copied that
 * the spec did not name. Linear in the number of fields plus the text sizes.
 */
export function validateFormValues(fields: readonly FormField[], raw: unknown): FormValidation {
  const errors: Record<string, FieldError> = {};
  // A key off the wire can be `__proto__`: assign it as an OWN property, never through the setter.
  const flag = (key: string, error: FieldError): void => {
    Object.defineProperty(errors, key, {
      value: error,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  const values: Record<string, FormScalar> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: { "": "type" } };
  }
  const known = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(raw)) if (!known.has(key)) flag(key, "unknown");
  for (const f of fields) {
    const v = Object.hasOwn(raw, f.name) ? (raw as Record<string, unknown>)[f.name] : undefined;
    const blank = v === undefined || v === null || v === "";
    if (blank) {
      if (f.type === "boolean") {
        // An unchecked box is `false`, not "missing".
        values[f.name] = false;
        continue;
      }
      if (f.required === true) flag(f.name, "required");
      continue;
    }
    switch (f.type) {
      case "text":
      case "textarea": {
        if (typeof v !== "string") {
          flag(f.name, "type");
          break;
        }
        const max = Math.min(f.maxLength ?? MAX_INPUT_CHARS, MAX_INPUT_CHARS);
        if (v.length > max) {
          flag(f.name, "too-long");
          break;
        }
        // Sanitise FIRST: it is what turns CR / U+2028 / U+2029 into newlines, so a single-line field
        // flattens them AFTER, never before (a replace-then-sanitise leaves a line break in a one-liner).
        const clean = sanitizeChatText(v, max);
        const text = f.type === "text" ? clean.replace(/\n/g, " ") : clean;
        if (text.trim() === "") {
          if (f.required === true) flag(f.name, "required");
          break;
        }
        values[f.name] = text;
        break;
      }
      case "number": {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (typeof n !== "number" || !Number.isFinite(n)) {
          flag(f.name, "type");
          break;
        }
        if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          flag(f.name, "range");
          break;
        }
        values[f.name] = n;
        break;
      }
      case "boolean": {
        if (typeof v !== "boolean") flag(f.name, "type");
        else values[f.name] = v;
        break;
      }
      case "select": {
        if (typeof v !== "string") flag(f.name, "type");
        else if (!(f.options ?? []).some((o) => o.value === v)) flag(f.name, "option");
        else values[f.name] = v;
        break;
      }
    }
  }
  return Object.keys(errors).length === 0 ? { ok: true, values } : { ok: false, errors };
}

export type SelectValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: FieldError };

/** `raw` must be exactly one of `options`' values. */
export function validateSelectValue(
  options: readonly InputOption[],
  raw: unknown
): SelectValidation {
  if (typeof raw !== "string") return { ok: false, error: "type" };
  return options.some((o) => o.value === raw)
    ? { ok: true, value: raw }
    : { ok: false, error: "option" };
}

export type SelectManyValidation =
  | { readonly ok: true; readonly values: readonly string[] }
  | { readonly ok: false; readonly error: "type" | "option" | "range" };

/** A whole new choice for a MultiSelectInput: a list of distinct values the HOST published, at most `max`. */
export function validateSelectManyValues(
  allowed: ReadonlySet<string>,
  raw: unknown,
  max: number
): SelectManyValidation {
  if (!Array.isArray(raw)) return { ok: false, error: "type" };
  if (raw.length > max) return { ok: false, error: "range" };
  const seen = new Set<string>();
  for (const v of raw as readonly unknown[]) {
    if (typeof v !== "string") return { ok: false, error: "type" };
    if (!allowed.has(v) || seen.has(v)) return { ok: false, error: "option" };
    seen.add(v);
  }
  return { ok: true, values: [...seen] };
}

export type TextValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: "type" | "required" | "too-long" };

/** Free text for a turn: a string, not blank once sanitised, at most `maxChars` (default {@link MAX_INPUT_CHARS}). */
export function validateTextValue(raw: unknown, maxChars = MAX_INPUT_CHARS): TextValidation {
  if (typeof raw !== "string") return { ok: false, error: "type" };
  const limit = Math.min(maxChars, MAX_INPUT_CHARS);
  if (raw.length > limit) return { ok: false, error: "too-long" };
  const text = sanitizeChatText(raw, limit);
  if (text.trim() === "") return { ok: false, error: "required" };
  return { ok: true, text };
}
