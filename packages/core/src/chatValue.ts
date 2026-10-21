// ── Chat: the transcript value contract (U8) ────────────────────────────────────────────────────
//
// A `Chat` widget is bound (like any data widget) to a handle whose hydrated VALUE is a
// {@link ChatValue}: a bounded window of turns, oldest first, plus the cursor to load earlier ones.
// It is the shape loom's conversation layer (`@loom/conversation`, ADR 0122) emits once a client has
// folded it (`ChatFeed` in `chatFeed.ts`), but it names no loom type and imports nothing from loom:
// any transcript source that can say this much can feed the widget.
//
// WHAT THE CONTRACT GUARANTEES, because every reader (store, seen log, renderer) trusts it:
//  - STRICT. A field outside the lists below (`classes`, `turnExecutionId`, a stray `html`...) is
//    refused, so what a source forgot to strip cannot ride along into a store or a screen.
//  - BOUNDED. Entries, parts, tools and every text are capped; the checker is linear in the value.
//  - A RESTRICTED entry is a BARE PLACEHOLDER: it carries no parts, tools, reason, error id or edit
//    reference, whatever the source meant. The check is here, not only in the renderer, so a value
//    that leaks content through a placeholder never reaches a store.
//  - Failure text is FIXED: `reason` is a short token the renderer maps to its own words; the source's
//    error text never reaches a viewer.
//  - User and tool text is UNTRUSTED. It is data to draw as text; nothing in this contract (and no
//    renderer) treats it as markup.
//
// Zod-free and DOM-free on purpose, like `mediaRef.ts`: it rides in `checkKindValue` on the browser
// entry, and the rest of the chat surface is the opt-in `@loom-ui/core/chat`.

import { MAX_CHAT_REFS } from "./chatRefs";
import { type MediaRef, mediaValueIssues } from "./mediaRef";

/** The kind that DISPLAYS a transcript: bound to a {@link ChatValue}. */
export const CHAT_KIND = "Chat";
/** The kinds that COLLECT input: static (props only), never bound. File upload is the existing `MediaInput`. */
export const TEXT_INPUT_KIND = "TextInput";
export const FORM_INPUT_KIND = "FormInput";
export const SELECT_INPUT_KIND = "SelectInput";
export const CHAT_INPUT_KINDS = [TEXT_INPUT_KIND, FORM_INPUT_KIND, SELECT_INPUT_KIND] as const;
export type ChatInputKind = (typeof CHAT_INPUT_KINDS)[number];
/** Every kind the chat vocabulary adds. */
export const CHAT_KINDS = [CHAT_KIND, ...CHAT_INPUT_KINDS] as const;

export const isChatKind = (kind: string): boolean => kind === CHAT_KIND;
export const isChatInputKind = (kind: string): kind is ChatInputKind =>
  (CHAT_INPUT_KINDS as readonly string[]).includes(kind);

export type ChatRole = "user" | "assistant" | "system";
export type ChatEntryStatus =
  | "complete"
  | "streaming"
  | "interrupted"
  | "failed"
  | "rejected"
  | "restricted";
const ROLES: readonly string[] = ["user", "assistant", "system"];
const STATUSES: readonly string[] = [
  "complete",
  "streaming",
  "interrupted",
  "failed",
  "rejected",
  "restricted",
];

/** Who spoke: loom's bounded identity (`{ tenant?, actor, onBehalfOf? }`). Attribution, never an authority. */
export interface ChatActor {
  readonly actor: string;
  readonly tenant?: string;
  readonly onBehalfOf?: string;
}

export type ChatPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "media"; readonly ref: MediaRef };

/** What a turn did, one line: a tool's name and how it ended. A summary, never arguments or results. */
export interface ChatToolActivity {
  readonly name: string;
  readonly status: "running" | "done" | "failed";
}

/** What kind of reasoning this is. A `summary` is NEVER presented as the full chain of thought; `redacted` carries no text. */
export type ChatReasoningKind = "text" | "summary" | "redacted";
/**
 * How the reasoning stands. Absent = `ok`. `erased` (removed on purpose) and `digest-mismatch` (the
 * stored text no longer matches its record) carry no text. `unloaded` / `loading` / `unavailable` are the
 * lazy durable fetch (`ChatFeed({ reasoning: { durable: true } })`): not asked for yet, in flight, none kept.
 */
export type ChatReasoningStatus =
  | "ok"
  | "erased"
  | "digest-mismatch"
  | "unloaded"
  | "loading"
  | "unavailable";

/**
 * A reply's model reasoning (loom ADR 0133). Model output derived from untrusted input: TEXT only,
 * like any reply text. Optional on an assistant entry; a host that never shows reasoning never sees the field.
 */
export interface ChatReasoning {
  readonly text: string;
  readonly kind: ChatReasoningKind;
  /** The reply is still being produced and `text` is still growing. */
  readonly streaming: boolean;
  /** Only part of the reasoning is here (the server's bound, or this client's). */
  readonly truncated?: boolean;
  readonly status?: ChatReasoningStatus;
}

/** One thing an entry may cite with a `[[id]]` marker. */
export interface ChatRef {
  readonly id: string;
}

export interface ChatEntry {
  /** Stable for the life of the turn's slot (`t<turn>.<role>`): the streaming entry and its durable successor share it, so nothing remounts. */
  readonly id: string;
  /** The turn number, 1-based. */
  readonly turn: number;
  readonly role: ChatRole;
  readonly status: ChatEntryStatus;
  /** Content, in order. Absent / empty on a restricted entry, and on a turn with no content (failed before any). */
  readonly parts?: readonly ChatPart[];
  readonly asker?: ChatActor;
  /** `<generation>.<sequence>`: where the entry sits in the source log. Absent on a streaming entry. */
  readonly cursor?: string;
  /** Epoch ms the source recorded it. */
  readonly at?: number;
  /** A fixed token (`model-error`, `denied`, `cancelled`, `too-long`...). The renderer owns the words. */
  readonly reason?: string;
  /** Correlation id for the host's log of the real error. Shown as a reference, never as an explanation. */
  readonly errorId?: string;
  /** This turn is a NEW turn that re-asks / revises an earlier one (append-only: history is never edited). */
  readonly editOf?: number;
  readonly tools?: readonly ChatToolActivity[];
  /** An assistant entry's reasoning, when the host asked for it and the server sent it to this viewer. */
  readonly reasoning?: ChatReasoning;
  /** Ids the entry's text may cite as [[id]] markers (an assistant entry; the source sets ChatValue.refMarkers). */
  readonly refs?: readonly ChatRef[];
}

export interface ChatValue {
  /** The window, oldest first. At most {@link MAX_CHAT_ENTRIES}. */
  readonly entries: readonly ChatEntry[];
  /** The viewer, when known: their own turns are marked and are the only ones that may be edited. */
  readonly viewer?: ChatActor;
  /** The cursor that loads the entries before the window. Absent = the start of the conversation is in the window. */
  readonly older?: string;
  /** `closed`: no further turns will be accepted. */
  readonly state?: "open" | "closed";
  /** A reply is on its way (the last user turn is unanswered). */
  readonly running?: boolean;
  /**
   * What the source KNOWS about whose turns these are. `owner`: an owner-only conversation, so a user
   * turn with no `asker` is the viewer's own. `shared`: attribution is on every user turn, and one with
   * none is nobody in particular. Absent (unknown): a user turn with no `asker` is NEUTRAL ("User"),
   * never "You" and never editable.
   */
  readonly mode?: "owner" | "shared";
  /** The source writes `[[id]]` markers in assistant text: only then does a widget process them (absent = text exactly as sent). */
  readonly refMarkers?: boolean;
}

export const MAX_CHAT_ENTRIES = 500;
export const MAX_CHAT_PARTS = 32;
export const MAX_CHAT_TEXT = 65_536;
export const MAX_CHAT_TOOLS = 16;
/** The most reasoning text one reply holds. */
export const MAX_CHAT_REASONING_TEXT = 65_536;
export const MAX_CHAT_TOOL_NAME = 64;
export const MAX_ACTOR_FIELD = 256;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURSOR = /^[0-9]{1,9}\.[0-9]{1,15}$/;
const REASON = /^[a-z][a-z0-9-]{0,31}$/;
const ERROR_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isChatCursor = (c: unknown): c is string => typeof c === "string" && CURSOR.test(c);
export const isChatReason = (r: unknown): r is string => typeof r === "string" && REASON.test(r);
export const isChatErrorId = (r: unknown): r is string => typeof r === "string" && ERROR_ID.test(r);
export const isChatEntryId = (r: unknown): r is string => typeof r === "string" && ID.test(r);

export interface ChatIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Equal iff all three fields are equal (loom's rule: an absent field equals only an absent field). */
export function sameChatActor(a: ChatActor | undefined, b: ChatActor | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.actor === b.actor &&
    a.tenant === b.tenant &&
    a.onBehalfOf === b.onBehalfOf
  );
}

const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as never)[k] : undefined);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** The first key of `v` not in `known`, if any. */
const extraKey = (v: object, known: ReadonlySet<string>): boolean =>
  Object.keys(v).some((k) => !known.has(k));

const ACTOR_KEYS: ReadonlySet<string> = new Set(["actor", "tenant", "onBehalfOf"]);
/** Why `v` is not a {@link ChatActor}, value-free; undefined when it is. */
export function actorProblem(v: unknown): string | undefined {
  if (!isRecord(v)) return "Expected an actor";
  const actor = own(v, "actor");
  if (typeof actor !== "string" || actor.length === 0 || actor.length > MAX_ACTOR_FIELD)
    return "actor must be text";
  for (const k of ["tenant", "onBehalfOf"] as const) {
    const x = own(v, k);
    if (x !== undefined && (typeof x !== "string" || x.length > MAX_ACTOR_FIELD))
      return `${k} must be text`;
  }
  if (extraKey(v, ACTOR_KEYS)) return "unexpected field";
  return undefined;
}

const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "turn",
  "role",
  "status",
  "parts",
  "asker",
  "cursor",
  "at",
  "reason",
  "errorId",
  "editOf",
  "tools",
  "reasoning",
  "refs",
]);
const REASONING_KEYS: ReadonlySet<string> = new Set([
  "text",
  "kind",
  "streaming",
  "truncated",
  "status",
]);
const REASONING_KINDS: readonly string[] = ["text", "summary", "redacted"];
const REASONING_STATUSES: readonly string[] = [
  "ok",
  "erased",
  "digest-mismatch",
  "unloaded",
  "loading",
  "unavailable",
];
const TOOL_STATUSES: readonly string[] = ["running", "done", "failed"];
const VALUE_KEYS: ReadonlySet<string> = new Set([
  "entries",
  "viewer",
  "older",
  "state",
  "running",
  "mode",
  "refMarkers",
]);
const MAX_ISSUES = 20;

function partIssues(part: unknown, path: (string | number)[], out: ChatIssue[]): void {
  const at = (msg: string, extra: (string | number)[] = []): void => {
    if (out.length < MAX_ISSUES) out.push({ path: [...path, ...extra], message: msg });
  };
  if (!isRecord(part)) {
    at("Expected a content part");
    return;
  }
  const type = own(part, "type");
  if (type === "text") {
    const text = own(part, "text");
    if (typeof text !== "string") at("text is required", ["text"]);
    else if (text.length > MAX_CHAT_TEXT)
      at(`text is at most ${MAX_CHAT_TEXT} characters`, ["text"]);
    if (extraKey(part, new Set(["type", "text"]))) at("unexpected field");
    return;
  }
  if (type === "media") {
    const ref = own(part, "ref");
    // A chat attachment is any media: the family is not pinned to a kind (`File` accepts any type).
    for (const i of mediaValueIssues("File", ref)) at(i.message, ["ref", ...i.path]);
    if (extraKey(part, new Set(["type", "ref"]))) at("unexpected field");
    return;
  }
  at("type must be text or media", ["type"]);
}

function entryIssues(e: unknown, index: number, ids: Set<string>, out: ChatIssue[]): void {
  const path: (string | number)[] = ["entries", index];
  const at = (msg: string, extra: (string | number)[] = []): void => {
    if (out.length < MAX_ISSUES) out.push({ path: [...path, ...extra], message: msg });
  };
  if (!isRecord(e)) {
    at("Expected a chat entry");
    return;
  }
  const id = own(e, "id");
  if (typeof id !== "string" || !ID.test(id)) at("id must be a short identifier", ["id"]);
  else if (ids.has(id)) at("id appears more than once", ["id"]);
  else ids.add(id);
  const turn = own(e, "turn");
  const role = own(e, "role");
  // loom records a REJECTED user message under turn 0 (it never took a turn — ADR 0122 R17b); every
  // other entry is on a real, 1-based turn.
  const rejectedUser = role === "user" && own(e, "status") === "rejected";
  if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < (rejectedUser ? 0 : 1))
    at("turn must be a positive integer (0 only for a rejected user message)", ["turn"]);
  if (typeof role !== "string" || !ROLES.includes(role))
    at("role must be user, assistant or system", ["role"]);
  const status = own(e, "status");
  if (typeof status !== "string" || !STATUSES.includes(status))
    at("status is not a known entry status", ["status"]);
  if (status === "streaming" && role !== "assistant")
    at("only an assistant entry can be streaming", ["status"]);
  const asker = own(e, "asker");
  if (asker !== undefined) {
    const p = actorProblem(asker);
    if (p !== undefined) at(p, ["asker"]);
  }
  const cursor = own(e, "cursor");
  if (cursor !== undefined && !isChatCursor(cursor)) at("cursor is not a position", ["cursor"]);
  const atMs = own(e, "at");
  if (atMs !== undefined && (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0))
    at("at must be a time", ["at"]);
  const reason = own(e, "reason");
  if (reason !== undefined && !isChatReason(reason)) at("reason must be a short token", ["reason"]);
  const errorId = own(e, "errorId");
  if (errorId !== undefined && !isChatErrorId(errorId))
    at("errorId must be a short token", ["errorId"]);
  const editOf = own(e, "editOf");
  if (
    editOf !== undefined &&
    (typeof editOf !== "number" || !Number.isSafeInteger(editOf) || editOf < 1)
  )
    at("editOf must be a turn number", ["editOf"]);
  if (typeof turn === "number" && typeof editOf === "number" && editOf >= turn)
    at("editOf must name an earlier turn", ["editOf"]);
  const parts = own(e, "parts");
  if (parts !== undefined) {
    if (!Array.isArray(parts)) at("parts must be a list", ["parts"]);
    else if (parts.length > MAX_CHAT_PARTS) at(`at most ${MAX_CHAT_PARTS} parts`, ["parts"]);
    else {
      let chars = 0;
      for (let i = 0; i < parts.length; i++) {
        partIssues(parts[i], [...path, "parts", i], out);
        const t = (parts[i] as { text?: unknown } | null)?.text;
        if (typeof t === "string") chars += t.length;
      }
      if (chars > MAX_CHAT_TEXT * 2) at("the entry's text is too long", ["parts"]);
    }
  }
  const tools = own(e, "tools");
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length > MAX_CHAT_TOOLS)
      at(`tools is a list of at most ${MAX_CHAT_TOOLS}`, ["tools"]);
    else
      for (let i = 0; i < tools.length; i++) {
        const t = tools[i];
        const name = isRecord(t) ? own(t, "name") : undefined;
        const st = isRecord(t) ? own(t, "status") : undefined;
        if (
          !isRecord(t) ||
          typeof name !== "string" ||
          name.length === 0 ||
          name.length > MAX_CHAT_TOOL_NAME ||
          typeof st !== "string" ||
          !TOOL_STATUSES.includes(st) ||
          extraKey(t, new Set(["name", "status"]))
        )
          at("a tool activity is { name, status }", ["tools", i]);
      }
  }
  const reasoning = own(e, "reasoning");
  if (reasoning !== undefined) {
    if (role !== "assistant") at("only an assistant entry carries reasoning", ["reasoning"]);
    else if (!isRecord(reasoning)) at("reasoning is { text, kind, streaming }", ["reasoning"]);
    else {
      const rText = own(reasoning, "text");
      const rKind = own(reasoning, "kind");
      const rStatus = own(reasoning, "status");
      if (typeof rText !== "string" || rText.length > MAX_CHAT_REASONING_TEXT)
        at(`reasoning text is at most ${MAX_CHAT_REASONING_TEXT} characters`, [
          "reasoning",
          "text",
        ]);
      if (typeof rKind !== "string" || !REASONING_KINDS.includes(rKind))
        at("reasoning kind must be text, summary or redacted", ["reasoning", "kind"]);
      if (typeof own(reasoning, "streaming") !== "boolean")
        at("reasoning streaming must be true or false", ["reasoning", "streaming"]);
      const rTrunc = own(reasoning, "truncated");
      if (rTrunc !== undefined && typeof rTrunc !== "boolean")
        at("reasoning truncated must be true or false", ["reasoning", "truncated"]);
      if (
        rStatus !== undefined &&
        (typeof rStatus !== "string" || !REASONING_STATUSES.includes(rStatus))
      )
        at("reasoning status is not a known status", ["reasoning", "status"]);
      // Redacted, erased, unverifiable and not-yet-loaded reasoning has NO text: nothing rides on it.
      if (
        typeof rText === "string" &&
        rText !== "" &&
        (rKind === "redacted" || (rStatus !== undefined && rStatus !== "ok"))
      )
        at("reasoning that is redacted, removed or not loaded carries no text", [
          "reasoning",
          "text",
        ]);
      if (extraKey(reasoning, REASONING_KEYS)) at("unexpected field", ["reasoning"]);
    }
  }
  const refs = own(e, "refs");
  if (refs !== undefined) {
    if (role !== "assistant") at("only an assistant entry has refs", ["refs"]);
    else if (!Array.isArray(refs)) at("refs must be a list", ["refs"]);
    else if (refs.length > MAX_CHAT_REFS) at(`at most ${MAX_CHAT_REFS} refs`, ["refs"]);
    else {
      const seen = new Set<string>();
      for (let i = 0; i < refs.length; i++) {
        const r = refs[i];
        const id = isRecord(r) ? own(r, "id") : undefined;
        if (!isRecord(r) || !isChatEntryId(id) || extraKey(r, new Set(["id"])))
          at("a ref id must be a short identifier", ["refs", i]);
        else if (seen.has(id)) at("ref ids must be unique", ["refs", i]);
        else seen.add(id);
      }
    }
  }
  // A restricted entry is a bare placeholder: nothing a viewer is not cleared for may ride on it.
  if (status === "restricted") {
    for (const k of ["parts", "tools", "reason", "errorId", "editOf", "reasoning", "refs"] as const)
      if (own(e, k) !== undefined) at("a restricted entry carries no content", [k]);
  }
  if (extraKey(e, ENTRY_KEYS)) at("unexpected field");
}

/**
 * Every way `value` fails the {@link ChatValue} contract, in a fixed order, at most 20. Value-free
 * messages (they reach a viewer's error state). ONE function backs both the zod contract and the
 * zod-free one, so the two cannot drift. Linear in the value.
 */
export function chatValueIssues(value: unknown): ChatIssue[] {
  const out: ChatIssue[] = [];
  if (!isRecord(value)) return [{ path: [], message: "Expected a chat transcript" }];
  const entries = own(value, "entries");
  if (!Array.isArray(entries)) out.push({ path: ["entries"], message: "entries is required" });
  else if (entries.length > MAX_CHAT_ENTRIES)
    out.push({ path: ["entries"], message: `at most ${MAX_CHAT_ENTRIES} entries` });
  else {
    const ids = new Set<string>();
    for (let i = 0; i < entries.length && out.length < MAX_ISSUES; i++)
      entryIssues(entries[i], i, ids, out);
  }
  const viewer = own(value, "viewer");
  if (viewer !== undefined) {
    const p = actorProblem(viewer);
    if (p !== undefined) out.push({ path: ["viewer"], message: p });
  }
  const older = own(value, "older");
  if (older !== undefined && !isChatCursor(older))
    out.push({ path: ["older"], message: "older must be a cursor" });
  const state = own(value, "state");
  if (state !== undefined && state !== "open" && state !== "closed")
    out.push({ path: ["state"], message: "state must be open or closed" });
  const mode = own(value, "mode");
  if (mode !== undefined && mode !== "owner" && mode !== "shared")
    out.push({ path: ["mode"], message: "mode must be owner or shared" });
  const running = own(value, "running");
  if (running !== undefined && typeof running !== "boolean")
    out.push({ path: ["running"], message: "running must be true or false" });
  const refMarkers = own(value, "refMarkers");
  if (refMarkers !== undefined && typeof refMarkers !== "boolean")
    out.push({ path: ["refMarkers"], message: "refMarkers must be true or false" });
  if (extraKey(value, VALUE_KEYS)) out.push({ path: [], message: "unexpected field" });
  return out;
}

/** The {@link ChatValue} verdict as a type guard (the contract, not a cast). */
export function isChatValue(value: unknown): value is ChatValue {
  return chatValueIssues(value).length === 0;
}
