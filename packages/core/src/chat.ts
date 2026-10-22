import type { SemanticEntry, SurfaceResolution } from "./catalog";
import { MAX_INPUT_CHARS, MAX_LABEL, fieldsProblem, optionsProblem } from "./chatForm";
import {
  CHAT_INPUT_KINDS,
  CHAT_KIND,
  CHAT_KINDS,
  FORM_INPUT_KIND,
  SELECT_INPUT_KIND,
  TEXT_INPUT_KIND,
} from "./chatValue";
import type { Finding } from "./experience";

// The rest of the chat surface (U8): the catalogue, the composition-time guard, and the words both
// renderers share. The CONTRACT lives in `chatValue.ts` (it is part of `checkKindValue`, so it rides
// in every client bundle); everything here is imported from `@loom-ui/core/chat` only by the code
// that needs it. Zod-free, DOM-free.
export * from "./chatUi";
export * from "./chatFeed";
export * from "./chatHost";

// ── The catalogue and the composition-time guard ──────────────────────────────────────────────────

/** The props a model-composed chat node may carry. Never transcript content, never a value, never a default. */
export const CHAT_ALLOWED_PROPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [CHAT_KIND]: ["emptyText", "editable"],
  [TEXT_INPUT_KIND]: ["label", "placeholder", "multiline", "maxChars", "submitLabel"],
  [FORM_INPUT_KIND]: ["label", "fields", "submitLabel"],
  [SELECT_INPUT_KIND]: ["label", "options", "placeholder", "size"],
});

/** The text-valued props (a `LocalizedText` is allowed there; resolved at compile). */
export const CHAT_TEXT_PROPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [CHAT_KIND]: ["emptyText"],
  [TEXT_INPUT_KIND]: ["label", "placeholder", "submitLabel"],
  [FORM_INPUT_KIND]: ["label", "submitLabel"],
  [SELECT_INPUT_KIND]: ["label", "placeholder"],
});

/** The version the chat entries declare; bump with a kind's props or value contract. */
export const CHAT_TYPE_VERSION = "1.1.0";

/** How a SelectInput is sized: `default` fills its row; `compact` fits its content so it can sit beside other controls. */
export const SELECT_SIZES: readonly string[] = ["default", "compact"];

const textOf = (raw: unknown): unknown =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { fallback?: unknown }).fallback === "string"
    ? (raw as { fallback: string }).fallback
    : raw;

/**
 * Findings for a chat node's props, against the framework's allow-list (independent of what the
 * catalogue declares). ERRORS: a prop outside the list (`entries`, `messages`, `value`, `defaultValue`,
 * `text`...: a composer cannot author transcript content or a value a user "entered"), a text
 * prop that is not short text, `fields` / `options` that are not valid specs, a malformed bound.
 */
export function chatPropFindings(
  kind: string,
  nodeId: string,
  props: Readonly<Record<string, unknown>>
): Finding[] {
  const allowed = CHAT_ALLOWED_PROPS[kind];
  if (allowed === undefined) return [];
  const out: Finding[] = [];
  const err = (code: string, message: string): void => {
    out.push({ code, severity: "error", message, nodeId });
  };
  const texts = CHAT_TEXT_PROPS[kind] ?? [];
  for (const key of Object.keys(props)) {
    if (!allowed.includes(key)) {
      err(
        "chat-prop-forbidden",
        kind === CHAT_KIND
          ? `"${nodeId}": a Chat takes no "${key}" prop — a transcript comes only from its bound value, never from the node`
          : `"${nodeId}": a ${kind} takes no "${key}" prop — a value is entered by the user, never authored on the node`
      );
      continue;
    }
    const value = textOf(props[key]);
    if (texts.includes(key)) {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL)
        err("chat-prop-shape", `"${nodeId}": ${key} is short text`);
      continue;
    }
    if (key === "size") {
      if (!SELECT_SIZES.includes(value as string))
        err("chat-prop-shape", `"${nodeId}": size is one of ${SELECT_SIZES.join(", ")}`);
    } else if (key === "editable" || key === "multiline") {
      if (typeof value !== "boolean")
        err("chat-prop-shape", `"${nodeId}": ${key} is true or false`);
    } else if (key === "maxChars") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_INPUT_CHARS
      )
        err("chat-prop-shape", `"${nodeId}": maxChars is an integer from 1 to ${MAX_INPUT_CHARS}`);
    } else if (key === "fields") {
      const p = fieldsProblem(value);
      if (p !== undefined) err("chat-prop-shape", `"${nodeId}": ${p}`);
    } else if (key === "options") {
      const p = optionsProblem(value);
      if (p !== undefined) err("chat-prop-shape", `"${nodeId}": ${p}`);
    }
  }
  return out;
}

/**
 * The semantic entries for the chat kinds, ready to splice into a catalogue's `entries` (`Chat`,
 * `TextInput`, `FormInput`, `SelectInput`, each `@1.1.0`). A planner is offered chat and inputs ONLY
 * by including these. `Chat` requires a binding (its transcript); `SelectInput` alone may take an optional binding (its current choice); the other inputs take none. `surfaces`
 * names the surfaces to resolve (default `web` and `terminal`); every one resolves to the
 * framework kind. File upload is the existing `mediaCatalogEntries()` `MediaInput`.
 */
export function chatCatalogEntries(
  options: { readonly surfaces?: readonly string[] } = {}
): SemanticEntry[] {
  const surfaces = options.surfaces ?? ["web", "terminal"];
  const entry = (kind: string, binding: "required" | "optional" | "none"): SemanticEntry => {
    const props = CHAT_ALLOWED_PROPS[kind] as readonly string[];
    const resolution: SurfaceResolution = { kind, props: [...props], binding };
    return {
      name: kind,
      version: CHAT_TYPE_VERSION,
      props: [...props],
      binding,
      textProps: [...(CHAT_TEXT_PROPS[kind] ?? [])],
      surfaces: Object.fromEntries(surfaces.map((s) => [s, resolution])),
    };
  };
  return [
    entry(CHAT_KIND, "required"),
    ...CHAT_INPUT_KINDS.map((k) => entry(k, k === SELECT_INPUT_KIND ? "optional" : "none")),
  ];
}

export const isChatFamilyKind = (kind: string): boolean =>
  (CHAT_KINDS as readonly string[]).includes(kind);
