import type { SemanticEntry, SurfaceResolution } from "./catalog";
import { sameChatActor } from "./chatFeed";
import { MAX_INPUT_CHARS, MAX_LABEL, fieldsProblem, optionsProblem } from "./chatForm";
import { oneLineChatText } from "./chatText";
import {
  CHAT_INPUT_KINDS,
  CHAT_KIND,
  CHAT_KINDS,
  type ChatEntry,
  type ChatValue,
  FORM_INPUT_KIND,
  SELECT_INPUT_KIND,
  TEXT_INPUT_KIND,
} from "./chatValue";
import type { Finding } from "./experience";
import { describeMedia, mediaFamily } from "./media";

// The rest of the chat surface (U8): the catalogue, the composition-time guard, and the words both
// renderers share. The CONTRACT lives in `chatValue.ts` (it is part of `checkKindValue`, so it rides
// in every client bundle); everything here is imported from `@loom-ui/core/chat` only by the code
// that needs it. Zod-free, DOM-free.
export * from "./chatValue";
export * from "./chatText";
export * from "./chatForm";
export * from "./chatFeed";
export * from "./chatHost";

// ── The catalogue and the composition-time guard ──────────────────────────────────────────────────

/** The props a model-composed chat node may carry. Never transcript content, never a value, never a default. */
export const CHAT_ALLOWED_PROPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [CHAT_KIND]: ["emptyText", "editable"],
  [TEXT_INPUT_KIND]: ["label", "placeholder", "multiline", "maxChars", "submitLabel"],
  [FORM_INPUT_KIND]: ["label", "fields", "submitLabel"],
  [SELECT_INPUT_KIND]: ["label", "options", "placeholder"],
});

/** The text-valued props (a `LocalizedText` is allowed there; resolved at compile). */
export const CHAT_TEXT_PROPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [CHAT_KIND]: ["emptyText"],
  [TEXT_INPUT_KIND]: ["label", "placeholder", "submitLabel"],
  [FORM_INPUT_KIND]: ["label", "submitLabel"],
  [SELECT_INPUT_KIND]: ["label", "placeholder"],
});

/** The version the chat entries declare; bump with a kind's props or value contract. */
export const CHAT_TYPE_VERSION = "1.0.0";

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
    if (key === "editable" || key === "multiline") {
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
 * `TextInput`, `FormInput`, `SelectInput`, each `@1.0.0`). A planner is offered chat and inputs ONLY
 * by including these. `Chat` requires a binding (its transcript); the inputs take none. `surfaces`
 * names the surfaces to resolve (default `web` and `terminal`); every one resolves to the
 * framework kind. File upload is the existing `mediaCatalogEntries()` `MediaInput`.
 */
export function chatCatalogEntries(
  options: { readonly surfaces?: readonly string[] } = {}
): SemanticEntry[] {
  const surfaces = options.surfaces ?? ["web", "terminal"];
  const entry = (kind: string, binding: "required" | "none"): SemanticEntry => {
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
  return [entry(CHAT_KIND, "required"), ...CHAT_INPUT_KINDS.map((k) => entry(k, "none"))];
}

export const isChatFamilyKind = (kind: string): boolean =>
  (CHAT_KINDS as readonly string[]).includes(kind);

// ── Words both renderers share ───────────────────────────────────────────────────────────────────

/** The fixed words for a `reason` token. The token is the source's; the sentence is ours. */
const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "model-error": "The assistant ran into a problem.",
  denied: "That was not permitted.",
  "turn-failed": "The turn could not be completed.",
  cancelled: "The turn was cancelled.",
  "too-long": "The message was too long.",
  "prompt-too-large": "The message was too large to answer.",
  malformed: "The message was not understood.",
  unauthenticated: "The message could not be verified.",
  replayed: "The message was already received.",
  stale: "The message arrived too late.",
  "not-a-participant": "You are not a participant in this conversation.",
});
const GENERIC_REASON = "The message was not processed.";

/** One fixed sentence for a failure / rejection reason; unknown tokens get the generic sentence, never their own text. */
export function chatReasonText(reason: string | undefined): string {
  return reason !== undefined && Object.hasOwn(REASON_TEXT, reason)
    ? (REASON_TEXT[reason] as string)
    : GENERIC_REASON;
}

/** Is this user entry the viewer's own? (No `asker` = an owner-only conversation: the viewer is the owner.) */
export function isOwnChatEntry(entry: ChatEntry, viewer: ChatValue["viewer"]): boolean {
  if (entry.role !== "user") return false;
  if (entry.asker === undefined) return true;
  return sameChatActor(entry.asker, viewer);
}

/** `Alice`, from an actor; never the tenant. Untrusted text, cleaned and bounded. */
export function chatActorLabel(entry: ChatEntry): string {
  const a = entry.asker?.actor;
  return a === undefined ? "" : oneLineChatText(a, 60);
}

/** Who is speaking, in words: `You`, `Alice`, `Assistant`, `Notice`. */
export function chatSpeaker(entry: ChatEntry, viewer: ChatValue["viewer"]): string {
  if (entry.role === "assistant") return "Assistant";
  if (entry.role === "system") return "Notice";
  if (isOwnChatEntry(entry, viewer)) return "You";
  return chatActorLabel(entry) || "User";
}

/** The status note, in words (`interrupted`, `replying`, ...), or `""` for a plain complete entry. */
export function chatStatusNote(entry: ChatEntry): string {
  const parts: string[] = [];
  if (entry.status === "streaming") parts.push("replying");
  else if (entry.status === "interrupted") parts.push("interrupted");
  else if (entry.status === "failed") parts.push("failed");
  else if (entry.status === "rejected") parts.push("not accepted");
  if (entry.editOf !== undefined) parts.push(`edit of turn ${entry.editOf}`);
  return parts.join(", ");
}

const kindOfType = (mediaType: string): string =>
  (["Image", "Audio", "Video"] as const).find((k) =>
    mediaType.startsWith(mediaFamily(k) as string)
  ) ?? "File";

/**
 * A transcript as plain lines — what the terminal prints and what a screen reader's summary says.
 * Every text is cleaned and bounded; a restricted entry is a bare placeholder; a failure is the
 * fixed sentence plus its reference id. No address, URL or timestamp appears.
 */
export function chatTranscriptLines(
  value: ChatValue,
  options: { maxText?: number } = {}
): string[] {
  const maxText = options.maxText ?? 2000;
  const lines: string[] = [];
  for (const e of value.entries) {
    if (e.status === "restricted") {
      const by = chatActorLabel(e);
      lines.push(`[restricted ${e.role} turn${by === "" ? "" : ` from ${by}`}]`);
      continue;
    }
    const note = chatStatusNote(e);
    const head = `${chatSpeaker(e, value.viewer)}${note === "" ? "" : ` (${note})`}`;
    const body: string[] = [];
    for (const p of e.parts ?? []) {
      if (p.type === "text") {
        const t = oneLineChatText(p.text, maxText);
        if (t !== "") body.push(t);
      } else body.push(`[${describeMedia(kindOfType(p.ref.mediaType), p.ref)}]`);
    }
    if (e.status === "failed" || e.status === "rejected")
      body.push(
        `${chatReasonText(e.reason)}${e.errorId === undefined ? "" : ` (ref ${e.errorId})`}`
      );
    if (e.tools !== undefined && e.tools.length > 0)
      body.push(
        `[tools: ${e.tools.map((t) => `${oneLineChatText(t.name, 64)} ${t.status}`).join(", ")}]`
      );
    lines.push(`${head}: ${body.join(" ")}`.trimEnd());
  }
  return lines;
}
