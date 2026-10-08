// ── Chat input actions, and what the HOST must do with them (U8) ────────────────────────────────
//
// The input widgets emit WidgetActions. Like every action they are stamped by the renderer with
// `viewedVersion` (U5), and like every action they are CLIENT INPUT: whatever the widget checked,
// it checked in a browser the user controls. This module is the host half:
//
//   action ──► acceptChatSubmit ──► Submission ──► a write-back target
//              (re-validate, freshness,          (a conversation's sendTurn, a flow's resume
//               idempotency claim)                gate, setParams — all host-wired)
//
// Mirrors `acceptMediaAttach`: a typed refusal, total (never throws), and nothing the client put in
// the action is trusted beyond what the host's own spec for that widget allows.
//
// THE ACTION VOCABULARY (all `type`s, payloads are plain JSON):
//   SUBMIT_TEXT   { text, key }            a TextInput (a chat composer, a one-line answer)
//   SUBMIT_FORM   { values, key }          a FormInput
//   SELECT        { value, key }           a SelectInput
//   EDIT_TURN     { turn, text, key }      a Chat: the user revised an earlier turn of their own
//   LOAD_OLDER    { cursor }               a Chat: show earlier turns (a read; carries no key)
//   MEDIA_ATTACH  { ref }                  the existing U9 `MediaInput` (see `acceptMediaAttach`)
//
// IDEMPOTENCY. Every submit carries a `key` the widget minted when the draft began. A retry of the
// SAME submission (the host failed, the network dropped) carries the SAME key; the host's
// {@link SubmitLedger} accepts a (principal, widget, key) once. For a conversation the key becomes
// the turn's `messageId`, which loom's own dedupe (sender + id) honours again underneath.

import { type ActionOutcome, type CurrentHead, actionFreshness } from "./action";
import {
  EDIT_TURN_ACTION,
  LOAD_OLDER_ACTION,
  SELECT_ACTION,
  SUBMIT_FORM_ACTION,
  SUBMIT_TEXT_ACTION,
  isSubmitKey,
} from "./chatActions";
import {
  type FieldError,
  type FormField,
  type FormValues,
  type InputOption,
  MAX_INPUT_CHARS,
  validateFormValues,
  validateSelectValue,
  validateTextValue,
} from "./chatForm";
import { isChatCursor } from "./chatValue";

/** What the host knows an input node is: derived from the node's own props, never from the action. */
export type InputSpec =
  | { readonly kind: "TextInput"; readonly maxChars: number }
  | { readonly kind: "FormInput"; readonly fields: readonly FormField[] }
  | { readonly kind: "SelectInput"; readonly options: readonly InputOption[] }
  | { readonly kind: "Chat"; readonly editable: boolean };

export type Submission =
  | {
      readonly kind: "text";
      readonly widgetId: string;
      readonly key: string;
      readonly text: string;
    }
  | {
      readonly kind: "form";
      readonly widgetId: string;
      readonly key: string;
      readonly values: FormValues;
    }
  | {
      readonly kind: "select";
      readonly widgetId: string;
      readonly key: string;
      readonly value: string;
    }
  | {
      readonly kind: "edit";
      readonly widgetId: string;
      readonly key: string;
      readonly turn: number;
      readonly text: string;
    }
  | { readonly kind: "older"; readonly widgetId: string; readonly cursor: string };

export type ChatSubmitRefusal =
  | "not-a-submit" // not one of this vocabulary's actions, or no object payload
  | "not-an-input" // the widget it names is not an input the host knows
  | "wrong-input" // the action type does not match what that widget is
  | "bad-key" // the idempotency key is missing or malformed
  | "invalid" // the value fails the widget's spec (`errors` says which field, in fixed codes)
  | "stale" // the action was not taken on the current view
  | "duplicate" // this (principal, widget, key) was already accepted AND acted on
  | "in-flight" // this (principal, widget, key) was accepted and its write has not finished: it may still fail
  | "edit-not-allowed"; // the host does not allow this edit (no policy, not the user's, not editable)

export type ChatSubmitResult =
  | {
      readonly ok: true;
      readonly submission: Submission;
      /** Give the idempotency key back: the write-back failed, so a retry with the same key must be accepted. */
      readonly release: () => void;
      /** The write succeeded: from now on a repeat is a plain `duplicate`. Until then a repeat is `in-flight`. */
      readonly commit: () => void;
    }
  | {
      readonly ok: false;
      readonly reason: ChatSubmitRefusal;
      readonly errors?: Readonly<Record<string, FieldError>>;
    };

// ── The idempotency ledger ───────────────────────────────────────────────────────────────────────

export interface SubmitLedgerOptions {
  /** The most keys remembered (default 10 000); the OLDEST is forgotten first. */
  readonly max?: number;
  /** How long a key is remembered, ms (default one hour). */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * At-most-once admission of (principal, widget, key). Bounded in size and in time: insertion order
 * is time order, so eviction pops the front, O(1) amortised. A key that has aged out can be
 * accepted again; that is the stated limit, and why a conversation target also passes the key on as
 * the turn's `messageId` (loom dedupes again, within its own window).
 */
export class SubmitLedger {
  private readonly seen = new Map<string, { at: number; done: boolean }>();
  private readonly max: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(options: SubmitLedgerOptions = {}) {
    this.max = Math.max(1, options.max ?? 10_000);
    this.ttl = options.ttlMs ?? 3_600_000;
    this.now = options.now ?? Date.now;
  }

  private static slot(principal: string, widgetId: string, key: string): string {
    // NUL cannot occur in a widget id or a key; the principal is hashed-free text the host chose.
    return `${principal}\u0000${widgetId}\u0000${key}`;
  }

  /**
   * `new` the first time a (principal, widget, key) is claimed. A repeat is `pending` while the first
   * write is IN FLIGHT (it may still fail, so a repeat must not be told it landed) and `done` once
   * {@link commit} says it did. A claim nobody commits or releases stays `pending` until it ages out.
   */
  claim(principal: string, widgetId: string, key: string): "new" | "pending" | "done" {
    const t = this.now();
    for (const [slot, v] of this.seen) {
      if (this.seen.size <= this.max - 1 && t - v.at <= this.ttl) break;
      this.seen.delete(slot);
    }
    const slot = SubmitLedger.slot(principal, widgetId, key);
    const have = this.seen.get(slot);
    if (have !== undefined && t - have.at <= this.ttl) return have.done ? "done" : "pending";
    this.seen.delete(slot);
    this.seen.set(slot, { at: t, done: false });
    return "new";
  }

  commit(principal: string, widgetId: string, key: string): void {
    const v = this.seen.get(SubmitLedger.slot(principal, widgetId, key));
    if (v !== undefined) v.done = true;
  }

  release(principal: string, widgetId: string, key: string): void {
    this.seen.delete(SubmitLedger.slot(principal, widgetId, key));
  }

  get size(): number {
    return this.seen.size;
  }
}

// ── Accepting an action ──────────────────────────────────────────────────────────────────────────

export interface AcceptChatOptions {
  /** What a widget is, from the host's OWN experience (see `inputSpecsOf`); never from the action. */
  readonly specOf: (widgetId: string) => InputSpec | undefined;
  /** A stable key for the authenticated principal (e.g. `tenant/actor`). Scopes the ledger. */
  readonly principal: string;
  /**
   * The current head. For a CHAT or INPUT widget do not pass `bindingSeq`: a transcript moves by
   * design, and an input is static; it is the COMPOSITION that must not have moved (`stale`).
   */
  readonly current: CurrentHead;
  readonly ledger: SubmitLedger;
  /** May `principal` edit this turn? Required for `EDIT_TURN`: absent, every edit is refused. */
  readonly canEdit?: (
    turn: number,
    principal: string,
    context: { readonly widgetId: string }
  ) => boolean;
  /** Longest accepted text (default and ceiling {@link MAX_INPUT_CHARS}); a TextInput's own `maxChars` also applies. */
  readonly maxTextChars?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as never)[k] : undefined);

const TYPE_TO_KIND: Readonly<Record<string, InputSpec["kind"]>> = {
  [SUBMIT_TEXT_ACTION]: "TextInput",
  [SUBMIT_FORM_ACTION]: "FormInput",
  [SELECT_ACTION]: "SelectInput",
  [EDIT_TURN_ACTION]: "Chat",
  [LOAD_OLDER_ACTION]: "Chat",
};

/**
 * HOST-SIDE acceptance of an input action. In order:
 *
 *  1. it is one of the five actions with an object payload;
 *  2. `specOf(widgetId)` knows the widget and the action type matches what it is;
 *  3. the action is `fresh` against `current` (U5);
 *  4. the value re-validates against the host's OWN spec (the client's checks are discarded): text
 *     is sanitised and bounded, form values are rebuilt from declared fields only, a select value
 *     must be one of the declared options, an edit must be allowed by `canEdit`;
 *  5. the idempotency key is claimed on the ledger (last, so a refusal never burns a key).
 *
 * Returns the {@link Submission} to act on, or a typed refusal. Total: never throws. The `text` it
 * returns is the SANITISED text, which is what must be sent (controls and bidi marks removed).
 */
export function acceptChatSubmit(action: unknown, options: AcceptChatOptions): ChatSubmitResult {
  const refuse = (
    reason: ChatSubmitRefusal,
    errors?: Readonly<Record<string, FieldError>>
  ): ChatSubmitResult => ({ ok: false, reason, ...(errors !== undefined && { errors }) });
  try {
    if (!isRecord(action)) return refuse("not-a-submit");
    const type = own(action, "type");
    const widgetId = own(action, "widgetId");
    const payload = own(action, "payload");
    if (
      typeof type !== "string" ||
      !Object.hasOwn(TYPE_TO_KIND, type) ||
      typeof widgetId !== "string"
    )
      return refuse("not-a-submit");
    if (!isRecord(payload)) return refuse("not-a-submit");
    const spec = options.specOf(widgetId);
    if (spec === undefined) return refuse("not-an-input");
    if (spec.kind !== TYPE_TO_KIND[type]) return refuse("wrong-input");
    if (actionFreshness(action as never, options.current) !== "fresh") return refuse("stale");

    if (type === LOAD_OLDER_ACTION) {
      const cursor = own(payload, "cursor");
      if (!isChatCursor(cursor)) return refuse("invalid");
      return {
        ok: true,
        submission: { kind: "older", widgetId, cursor },
        release: () => {},
        commit: () => {},
      };
    }

    const key = own(payload, "key");
    if (!isSubmitKey(key)) return refuse("bad-key");
    let submission: Submission;
    switch (spec.kind) {
      case "TextInput": {
        const v = validateTextValue(
          own(payload, "text"),
          Math.min(spec.maxChars, options.maxTextChars ?? MAX_INPUT_CHARS)
        );
        if (!v.ok) return refuse("invalid", { text: v.error });
        submission = { kind: "text", widgetId, key, text: v.text };
        break;
      }
      case "FormInput": {
        const v = validateFormValues(spec.fields, own(payload, "values"));
        if (!v.ok) return refuse("invalid", v.errors);
        submission = { kind: "form", widgetId, key, values: v.values };
        break;
      }
      case "SelectInput": {
        const v = validateSelectValue(spec.options, own(payload, "value"));
        if (!v.ok) return refuse("invalid", { value: v.error });
        submission = { kind: "select", widgetId, key, value: v.value };
        break;
      }
      case "Chat": {
        if (!spec.editable || options.canEdit === undefined) return refuse("edit-not-allowed");
        const turn = own(payload, "turn");
        if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1)
          return refuse("invalid", { turn: "type" });
        const v = validateTextValue(own(payload, "text"), options.maxTextChars ?? MAX_INPUT_CHARS);
        if (!v.ok) return refuse("invalid", { text: v.error });
        let allowed = false;
        try {
          allowed = options.canEdit(turn, options.principal, { widgetId }) === true;
        } catch {
          allowed = false;
        }
        if (!allowed) return refuse("edit-not-allowed");
        submission = { kind: "edit", widgetId, key, turn, text: v.text };
        break;
      }
    }
    const claim = options.ledger.claim(options.principal, widgetId, key);
    if (claim === "done") return refuse("duplicate");
    if (claim === "pending") return refuse("in-flight");
    return {
      ok: true,
      submission,
      release: () => options.ledger.release(options.principal, widgetId, key),
      commit: () => options.ledger.commit(options.principal, widgetId, key),
    };
  } catch {
    return refuse("not-a-submit");
  }
}

// ── Write-back: where an accepted submission goes ────────────────────────────────────────────────

/** HOST CODE that acts on an accepted submission. May throw / reject: that reads as a failed write, and the key is released. */
export type SubmissionHandler = (submission: Submission) => unknown;
/** A handler may REFUSE by returning `{ ok: false, reason }` (a short token) instead of throwing: the key is released and the reason is the outcome's. */
const REFUSAL_REASON = /^[a-z][a-z0-9-]{0,31}$/;

export interface WriteBackOptions extends Omit<AcceptChatOptions, "principal" | "current"> {
  /** The handler per widget id. A widget with none is `no-route`: accepted nothing, claimed nothing. */
  readonly routes: Readonly<Record<string, SubmissionHandler>>;
}

export type WriteBackOutcome = ActionOutcome & {
  readonly submission?: Submission;
};

/**
 * The generic, host-wired action handler: accept → route → await → outcome. Its result is exactly
 * what a renderer's `onAction` may return, so a widget keeps the draft until it hears `ok: true`.
 *
 *   const writeBack = createWriteBack({ specOf, ledger, canEdit, routes: { composer: conversationTarget(...) } });
 *   onAction: (action) => writeBack.handle(action, { principal: key, current: head() })
 *
 * A duplicate answers `ok: true, reason: "duplicate"` (the first submission is the one that counts;
 * the user must not be told "failed" for a retry that already landed). A write that throws releases
 * the key (so the user's retry is accepted) and answers `ok: false, reason: "failed"`: the error is
 * NOT passed to the client.
 */
export function createWriteBack(options: WriteBackOptions): {
  handle(
    action: unknown,
    context: { readonly principal: string; readonly current: CurrentHead }
  ): Promise<WriteBackOutcome>;
} {
  return {
    async handle(action, context) {
      const accepted = acceptChatSubmit(action, { ...options, ...context });
      if (!accepted.ok) {
        if (accepted.reason === "duplicate") return { ok: true, reason: "duplicate" };
        // The first submission may still fail: a repeat is told to wait, never that it landed.
        if (accepted.reason === "in-flight") return { ok: false, reason: "pending" };
        return { ok: false, reason: accepted.reason };
      }
      const { submission, release, commit } = accepted;
      const route = Object.hasOwn(options.routes, submission.widgetId)
        ? options.routes[submission.widgetId]
        : undefined;
      if (route === undefined) {
        release();
        return { ok: false, reason: "no-route" };
      }
      try {
        const answer = await route(submission);
        if (
          typeof answer === "object" &&
          answer !== null &&
          (answer as { ok?: unknown }).ok === false
        ) {
          release();
          const r = (answer as { reason?: unknown }).reason;
          return {
            ok: false,
            reason: typeof r === "string" && REFUSAL_REASON.test(r) ? r : "failed",
          };
        }
      } catch {
        release();
        return { ok: false, reason: "failed" };
      }
      commit();
      return { ok: true, submission };
    },
  };
}

// ── Targets: structural adapters, so core imports nothing from loom ──────────────────────────────

/**
 * A conversation: `sendTurn(text, { messageId })` is `Conversations.sendTurn(id, text, { principal,
 * messageId })` with the conversation id and principal closed over. A text submission is a turn; an
 * EDIT is a NEW turn with the revised text (append-only: loom's history is never rewritten) unless
 * the host supplies `edit` to fork / branch / re-ask instead. The idempotency key is the turn's
 * `messageId`, so loom's own sender+id dedupe holds a retry to one turn.
 */
export function conversationTarget(
  sendTurn: (text: string, options: { readonly messageId: string }) => unknown,
  options: { readonly edit?: SubmissionHandler } = {}
): SubmissionHandler {
  return (s) => {
    if (s.kind === "text") return sendTurn(s.text, { messageId: s.key });
    if (s.kind === "edit")
      return options.edit !== undefined ? options.edit(s) : sendTurn(s.text, { messageId: s.key });
    // LOAD_OLDER is a READ the browser makes itself (`connection.loadOlder()`); routed here by mistake it
    // is refused with a reason, not a TypeError.
    if (s.kind === "older") return { ok: false, reason: "browser-side" };
    throw new TypeError("a conversation target takes text and edits");
  };
}

/**
 * A flow's resume gate: the host's `resume` is the authenticated runtime call (typed gates, ADR
 * 0077, parse the payload again with the gate's own schema, which remains the authority).
 * form → `values`, select → `{ value }`, text → `{ text }`.
 */
export function resumeTarget(
  resume: (payload: unknown, options: { readonly idempotencyKey: string }) => unknown
): SubmissionHandler {
  return (s) => {
    switch (s.kind) {
      case "form":
        return resume(s.values, { idempotencyKey: s.key });
      case "select":
        return resume({ value: s.value }, { idempotencyKey: s.key });
      case "text":
        return resume({ text: s.text }, { idempotencyKey: s.key });
      default:
        throw new TypeError("a resume target takes a form, a selection or text");
    }
  };
}

/**
 * `setParams` (hydration): select / text → `{ [name]: value }`, form → its values. The controller's
 * own `checkParams` still applies to what is set.
 */
export function paramsTarget(
  setParams: (params: Readonly<Record<string, string | number | boolean>>) => unknown,
  name = "value"
): SubmissionHandler {
  return (s) => {
    switch (s.kind) {
      case "form":
        return setParams(s.values);
      case "select":
        return setParams({ [name]: s.value });
      case "text":
        return setParams({ [name]: s.text });
      default:
        throw new TypeError("a params target takes a form, a selection or text");
    }
  };
}
