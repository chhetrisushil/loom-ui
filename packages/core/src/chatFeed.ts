// ── ChatFeed: folding loom's conversation API into a ChatValue (U8) ─────────────────────────────
//
// `@loom/conversation` + `@loom/plugin-conversation-sse` (loom ADR 0122) emit three things a client
// folds into one transcript: HISTORY PAGES (bounded, cursor-addressed, backward or forward), the
// DURABLE `message` events of the SSE stream, and the LIVE events (`partial`, `delta`, `reset`) that
// are never journaled. This class is that fold. It is PURE: no network, no timers, no DOM, no loom
// import. The host owns the transport (a `fetch` for history, an `EventSource` for events, see
// `@loom-ui/hydration/client`'s `connectConversation`) and calls `applyHistory` / `applyEvent`.
//
// EVERYTHING THAT ARRIVES IS UNTRUSTED. The wire is parsed field by field into the contract's
// shape; a field the contract does not name (`classes`, `executionId`, `turnExecutionId`) is
// DROPPED here, not carried; text is sanitised (`sanitizeChatText`); a failure's text never exists
// at all (only the fixed `reason` token and the `errorId` correlation id).
//
// THE RULES, each pinned by `chatFeed.test.ts`:
//  - APPEND-ONLY. A durable entry, once visible, is never changed by a later event for the same
//    turn: the log is immutable, so a different second copy is noise (or an attack) and is ignored.
//    The one upgrade is a `restricted` placeholder becoming the real entry (the viewer gained
//    clearance); the reverse is never applied (revoke by rebuilding the feed).
//  - IDEMPOTENT. A message delivered twice (an SSE reconnect re-reads from the cursor) is one entry.
//  - A RESTRICTED entry is bare: no text, no tools, no reason, whatever the wire carried. A
//    `rejected` entry carries no text either: an envelope the conversation refused is not content
//    its viewers should read (a same-tenant peer's refused "speaking as the owner" included).
//  - LIVE TEXT IS NOT HISTORY. A delta never touches a durable entry; a delta for a turn that
//    already has its durable reply is dropped; the durable reply replaces the live text in place
//    (same entry id, so nothing remounts). Deltas for a turn that is restricted, or (when the
//    viewer is known) asked by someone else, are NOT rendered: the server sends them to the asker
//    only (ADR 0122 D10.4), and this is the client's second line. REASONING is not filtered by asker:
//    the server sends it to the asker AND the owner (ADR 0133 D6) and the client cannot tell the owner
//    from a peer, so it renders whatever arrives (restricted turns excepted).
//  - BOUNDED. At most `maxEntries` entries (default and ceiling {@link MAX_CHAT_ENTRIES}); the live
//    reply is bounded like any stream (`appendChunk`: 64 K, closed on overflow).
//  - REASONING IS OPT-IN AND NEVER TEXT OF THE REPLY (loom ADR 0133 D6). Off unless `options.reasoning`
//    is set: then `reasoning` / `reasoning-partial` events, and nothing else, build a reply's `reasoning`
//    (a separate channel: it can never land in reply text). It is model output derived from untrusted
//    input, cleaned like reply text and drawn as text. `reset` / `closed` clear it with the reply; a
//    `reasoning-partial` REPLACES (a reconnect cannot duplicate it); the durable reply keeps the live
//    text; `durable` adds a lazy per-reply fetch (`beginReasoning` / `applyReasoning`), never eager.
//  - EDITS ARE NEW TURNS. `annotate(turn, { editOf })` labels a turn the host KNOWS is an edit; the
//    feed never infers one (loom's record has no such field today, see the README).

import { sanitizeChatText } from "./chatText";
import {
  type ChatActor,
  type ChatEntry,
  type ChatReasoning,
  type ChatReasoningKind,
  type ChatValue,
  MAX_CHAT_ENTRIES,
  MAX_CHAT_REASONING_TEXT,
  sameChatActor,
} from "./chatValue";
import { MAX_ACTOR_FIELD, isChatCursor, isChatErrorId, isChatReason } from "./chatValue";
import type { Finding } from "./experience";
import { MAX_CHUNK_TEXT, type StreamedText, appendChunk } from "./streamText";

export type ChatFeedResult =
  | { readonly ok: true; readonly changed: boolean; readonly reconnect?: boolean }
  | { readonly ok: false; readonly finding: Finding };

const refuse = (code: string, message: string): ChatFeedResult => ({
  ok: false,
  finding: { code, severity: "error", message },
});
const NOOP: ChatFeedResult = { ok: true, changed: false };
const CHANGED: ChatFeedResult = { ok: true, changed: true };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as never)[k] : undefined);

/** Parse an identity off the wire, or drop it. Bounded; extra fields dropped. */
export function parseChatActor(raw: unknown): ChatActor | undefined {
  if (!isRecord(raw)) return undefined;
  const actor = own(raw, "actor");
  if (typeof actor !== "string" || actor.length === 0 || actor.length > MAX_ACTOR_FIELD)
    return undefined;
  const tenant = own(raw, "tenant");
  const onBehalfOf = own(raw, "onBehalfOf");
  return {
    actor,
    ...(typeof tenant === "string" && tenant.length <= MAX_ACTOR_FIELD && { tenant }),
    ...(typeof onBehalfOf === "string" && onBehalfOf.length <= MAX_ACTOR_FIELD && { onBehalfOf }),
  };
}

const ROLE_RANK = { user: 0, assistant: 1, system: 2 } as const;
/** The slot of a turn's REPLY: the live text and its durable successor share it, so nothing remounts. */
const entryId = (turn: number, role: ChatEntry["role"]): string => `t${turn}.${role}`;
const KNOWN_STATUS = new Set(["complete", "interrupted", "failed", "rejected", "restricted"]);

/**
 * One history entry / `message` event body off the wire, as a {@link ChatEntry}; `undefined` when
 * it is not one (no valid turn or role). An unknown status becomes `restricted` (fail closed: it
 * keeps its place and says nothing). Total: never throws.
 */
export function chatEntryFromWire(raw: unknown): ChatEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const turn = own(raw, "turn");
  const role = own(raw, "role");
  if (role !== "user" && role !== "assistant") return undefined;
  const rawStatus = own(raw, "status");
  // A rejected user message is recorded under turn 0 by loom (ADR 0122 R17b): keep it, so the user
  // sees why it was refused. Every other entry needs a real, 1-based turn.
  if (
    typeof turn !== "number" ||
    !Number.isSafeInteger(turn) ||
    turn < (role === "user" && rawStatus === "rejected" ? 0 : 1)
  )
    return undefined;
  const status = (
    typeof rawStatus === "string" && KNOWN_STATUS.has(rawStatus) ? rawStatus : "restricted"
  ) as ChatEntry["status"];
  const cursor = own(raw, "cursor");
  const at = own(raw, "at");
  const asker = parseChatActor(own(raw, "asker"));
  const bare = status === "restricted";
  const reason = own(raw, "reason");
  const errorId = own(raw, "errorId");
  const text = bare || status === "rejected" ? "" : sanitizeChatText(own(raw, "text"));
  // loom's rejected envelopes are recorded under the NEXT turn number without consuming it (ADR 0122 D8),
  // so the turn number is NOT a key: a user entry is keyed by its record id (`ord`, when the source
  // provides one) or its log position (`cursor`, unique), and the next accepted turn can share a number
  // with any number of rejected ones. A reply is the one entry per accepted turn: it keeps the turn slot.
  const ord = own(raw, "ord");
  const id =
    role === "assistant"
      ? entryId(turn, role)
      : typeof ord === "number" && Number.isSafeInteger(ord) && ord >= 0
        ? `m${ord}`
        : isChatCursor(cursor)
          ? `u${cursor}`
          : // No position and no record id (a source without either): a rejected envelope still gets a slot
            // of its own, so it can never take the accepted turn's.
            status === "rejected"
            ? `t${turn}.rejected`
            : entryId(turn, role);
  // loom's `editOf` is the edited RECORD's `ord`; the edited TURN number (what this value calls
  // `editOf` and draws as "edit of turn N") is `editOfTurn` (ADR 0122 R17b). Only the turn number is used.
  const editOf = own(raw, "editOfTurn");
  return {
    id,
    turn,
    role,
    status,
    ...(text !== "" && { parts: [{ type: "text", text }] }),
    ...(asker !== undefined && { asker }),
    ...(isChatCursor(cursor) && { cursor }),
    ...(typeof at === "number" && Number.isFinite(at) && at >= 0 && { at }),
    ...(!bare && isChatReason(reason) && { reason }),
    ...(!bare && isChatErrorId(errorId) && { errorId }),
    // A source that records the link (loom's follow-up) is believed; the host's `annotate` is the interim.
    ...(!bare &&
      role === "user" &&
      typeof editOf === "number" &&
      Number.isSafeInteger(editOf) &&
      editOf >= 1 &&
      editOf < turn && { editOf }),
  };
}

/** `<generation>.<sequence>` as numbers, or undefined. */
function cursorKey(c: string | undefined): [number, number] | undefined {
  if (c === undefined || !isChatCursor(c)) return undefined;
  const i = c.indexOf(".");
  return [Number(c.slice(0, i)), Number(c.slice(i + 1))];
}
/** Order two cursors (generation, then sequence). Undefined cursors sort last. */
export function compareChatCursors(a: string | undefined, b: string | undefined): number {
  const x = cursorKey(a);
  const y = cursorKey(b);
  if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
  return x[0] - y[0] || x[1] - y[1];
}

export interface ChatFeedOptions {
  /** The viewer. Enables "my turns" in the value and the client-side filter on other askers' live text. */
  readonly viewer?: ChatActor;
  /** The most entries held (default and ceiling {@link MAX_CHAT_ENTRIES}). */
  readonly maxEntries?: number;
  /** What the source knows about whose turns these are (see `ChatValue.mode`); set `owner` for an owner-only conversation. */
  readonly mode?: "owner" | "shared";
  /**
   * Show the model's reasoning (loom ADR 0133). OFF by default: with it off the `reasoning` events are
   * ignored and no entry ever carries the field. `true` follows the live events; `{ durable: true }` also
   * offers each finished reply's stored reasoning for a lazy fetch (see {@link ChatFeed.beginReasoning});
   * `liveKind` is what the live events are labelled (the wire does not say; default `"summary"`, the
   * conservative label: set `"text"` only when your provider streams the raw reasoning).
   */
  readonly reasoning?:
    | boolean
    | { readonly durable?: boolean; readonly liveKind?: "text" | "summary" };
}

interface Live {
  readonly turn: number;
  stream: StreamedText;
}
interface LiveReasoning {
  readonly turn: number;
  text: string;
  truncated: boolean;
}

const UNLOADED: ChatReasoning = Object.freeze({
  text: "",
  kind: "text",
  streaming: false,
  status: "unloaded",
});
const LOADING: ChatReasoning = Object.freeze({
  text: "",
  kind: "text",
  streaming: false,
  status: "loading",
});
const UNAVAILABLE: ChatReasoning = Object.freeze({
  text: "",
  kind: "text",
  streaming: false,
  status: "unavailable",
});
const MAX_REASONING_STEPS = 256;
const MAX_REASONING_PARTS = 256;

/**
 * The durable `GET .../reasoning?cursor=` body (`{ steps: [{ stepId, recordedAttempt?, attempts: [{ attempt,
 * recorded, parts: [{ kind, status, text? }] }] }], truncated? }`) folded into ONE {@link ChatReasoning}, or
 * `undefined` when it holds nothing usable. Only the RECORDED attempt of each step counts (a superseded retry is
 * not what the model said). Texts are cleaned and joined by a blank line and bounded; a `summary` among the
 * parts makes the whole a `summary` (never upgraded); a part with no text is hidden reasoning (`redacted`);
 * a part that is erased or fails its digest never contributes text. Total: never throws.
 */
export function chatReasoningFromDurable(body: unknown): ChatReasoning | undefined {
  if (!isRecord(body)) return undefined;
  const steps = own(body, "steps");
  if (!Array.isArray(steps)) return undefined;
  const texts: string[] = [];
  let used = 0;
  let truncated = own(body, "truncated") === true;
  let summary = false;
  let hidden = false;
  let mismatch = false;
  let erased = false;
  let seen = 0;
  for (const st of steps.slice(0, MAX_REASONING_STEPS)) {
    if (!isRecord(st)) continue;
    const attempts = own(st, "attempts");
    if (!Array.isArray(attempts)) continue;
    const recordedAttempt = own(st, "recordedAttempt");
    for (const a of attempts.slice(0, 16)) {
      if (!isRecord(a)) continue;
      const isRecorded =
        own(a, "recorded") === true &&
        (typeof recordedAttempt !== "number" || own(a, "attempt") === recordedAttempt);
      if (!isRecorded) continue;
      const parts = own(a, "parts");
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        if (!isRecord(p) || seen >= MAX_REASONING_PARTS) continue;
        const kind = own(p, "kind");
        if (kind !== "text" && kind !== "summary" && kind !== "redacted") continue;
        seen++;
        const status = own(p, "status");
        if (status === "erased") erased = true;
        else if (status !== "ok")
          mismatch = true; // digest-mismatch, or a status we do not know: fail closed
        else {
          const raw = own(p, "text");
          const room = MAX_CHAT_REASONING_TEXT - used;
          const clean = kind === "redacted" ? "" : sanitizeChatText(raw, Math.max(0, room));
          if (clean === "") hidden = true;
          else {
            if (kind === "summary") summary = true;
            if (typeof raw === "string" && raw.length > room) truncated = true;
            texts.push(clean);
            used += clean.length + 2;
            if (used >= MAX_CHAT_REASONING_TEXT) truncated = true;
          }
        }
      }
    }
  }
  const base = { streaming: false, ...(truncated && { truncated: true }) } as const;
  if (texts.length > 0)
    return { text: texts.join("\n\n"), kind: summary ? "summary" : "text", ...base };
  if (hidden) return { text: "", kind: "redacted", ...base };
  if (mismatch) return { text: "", kind: "text", status: "digest-mismatch", ...base };
  if (erased) return { text: "", kind: "text", status: "erased", ...base };
  return undefined;
}

export class ChatFeed {
  private readonly viewer: ChatActor | undefined;
  private readonly mode: "owner" | "shared" | undefined;
  /** The most entries the VALUE holds (the live reply included). */
  private readonly max: number;
  /** The most DURABLE entries: one slot is always left for the live reply. */
  private readonly cap: number;
  /** Durable entries, in log order (by cursor; by turn and role for a source with none). */
  private list: ChatEntry[] = [];
  private index = new Map<string, number>();
  /** turn -> id of that turn's ACCEPTED user entry (a rejected envelope never binds a turn). */
  private acceptedUser = new Map<number, string>();
  /** cursor -> id of the entry at that log position. */
  private byCursor = new Map<string, string>();
  private live: Live | undefined;
  private older: string | undefined;
  private startReached = false;
  private state: "open" | "closed" = "open";
  private running = false;
  private readonly edits = new Map<number, number>();
  private snapshot: ChatValue | undefined;
  private readonly reasoningOn: boolean;
  private readonly durable: boolean;
  private readonly liveKind: ChatReasoningKind;
  private liveReasoning: LiveReasoning | undefined;
  /** Entry id -> the reasoning that entry keeps (the live text it ended with, or a fetched record). Bounded. */
  private readonly kept = new Map<string, ChatReasoning>();

  constructor(options: ChatFeedOptions = {}) {
    this.viewer = options.viewer;
    this.mode = options.mode;
    this.max = Math.max(2, Math.min(options.maxEntries ?? MAX_CHAT_ENTRIES, MAX_CHAT_ENTRIES));
    this.cap = this.max - 1;
    const r = options.reasoning;
    this.reasoningOn = r === true || (typeof r === "object" && r !== null);
    this.durable = typeof r === "object" && r !== null && r.durable === true;
    this.liveKind =
      typeof r === "object" && r !== null && r.liveKind === "text" ? "text" : "summary";
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────

  /** The transcript to publish to the widget's handle. The same object until something changes. */
  value(): ChatValue {
    if (this.snapshot !== undefined) return this.snapshot;
    const entries: ChatEntry[] = this.list.map((e0) => {
      const e = this.withReasoning(e0);
      const editOf = this.edits.get(e.turn);
      // Only the turn's ACCEPTED user entry, and never a placeholder (the contract refuses `editOf` on one).
      return e.role === "user" &&
        e.status !== "restricted" &&
        editOf !== undefined &&
        e.editOf === undefined &&
        this.acceptedUser.get(e.turn) === e.id
        ? { ...e, editOf }
        : e;
    });
    const live = this.liveEntry();
    if (live !== undefined) insertSorted(entries, live);
    const older = this.startReached || this.list.length >= this.cap ? undefined : this.older;
    this.snapshot = {
      entries,
      ...(this.viewer !== undefined && { viewer: this.viewer }),
      ...(older !== undefined && { older }),
      state: this.state,
      running: this.running || live !== undefined,
      ...(this.mode !== undefined && { mode: this.mode }),
    };
    return this.snapshot;
  }

  /** Is a reply streaming right now? (Drives the binding status: `pending` while true.) */
  get streaming(): boolean {
    return this.liveEntry() !== undefined;
  }

  /** Reasoning for a durable entry: what it kept, else (durable mode) the "not fetched yet" marker. */
  private withReasoning(e: ChatEntry): ChatEntry {
    if (!this.reasoningOn || e.role !== "assistant" || e.status === "restricted") return e;
    const kept = this.kept.get(e.id);
    if (kept !== undefined) return { ...e, reasoning: kept };
    if (this.durable && this.fetchable(e)) return { ...e, reasoning: UNLOADED };
    return e;
  }

  /** A finished reply whose stored reasoning this viewer could ask for. The server decides; this only avoids offering the pointless. */
  private fetchable(e: ChatEntry): boolean {
    if (e.cursor === undefined || (e.status !== "complete" && e.status !== "interrupted"))
      return false;
    if (this.mode !== "shared") return true;
    // Shared: the server sends reasoning to the turn's asker AND the owner (ADR 0133 D6). The client
    // cannot tell the owner from a peer, so it offers the marker on every finished reply and the server's
    // 404 (the same for every reason) settles it as `unavailable`.
    return true;
  }

  /**
   * The host is about to fetch the durable reasoning of the reply at `cursor` (a Chat's `LOAD_REASONING`).
   * `changed: true` = go ahead (the entry now reads `loading`); `changed: false` = do not (reasoning or
   * durable mode off, unknown cursor, not offered for this reply, already loaded or loading).
   */
  beginReasoning(cursor: string): ChatFeedResult {
    const e = this.durableTarget(cursor);
    if (e === undefined || this.kept.has(e.id)) return NOOP;
    this.remember(e.id, LOADING);
    return this.finish(true);
  }

  /** The fetched body for `cursor`. Nothing usable becomes `unavailable` (a settled answer, not retried). */
  applyReasoning(cursor: string, body: unknown): ChatFeedResult {
    const e = this.durableTarget(cursor);
    if (e === undefined || this.kept.get(e.id) !== LOADING) return NOOP;
    this.remember(e.id, chatReasoningFromDurable(body) ?? UNAVAILABLE);
    return this.finish(true);
  }

  /** The fetch for `cursor` failed in transit: back to `unloaded`, so a later expand tries again. */
  reasoningFailed(cursor: string): ChatFeedResult {
    const e = this.durableTarget(cursor);
    if (e === undefined || this.kept.get(e.id) !== LOADING) return NOOP;
    this.kept.delete(e.id);
    return this.finish(true);
  }

  /** The fetch for `cursor` was refused or found nothing (the server's 404 is the same for every reason). */
  reasoningUnavailable(cursor: string): ChatFeedResult {
    return this.applyReasoning(cursor, undefined);
  }

  private durableTarget(cursor: string): ChatEntry | undefined {
    if (!this.reasoningOn || !this.durable || !isChatCursor(cursor)) return undefined;
    const id = this.byCursor.get(cursor);
    const e = id === undefined ? undefined : this.list[this.index.get(id) ?? -1];
    return e !== undefined && e.role === "assistant" && this.fetchable(e) ? e : undefined;
  }

  private remember(id: string, r: ChatReasoning): void {
    this.kept.delete(id);
    this.kept.set(id, r);
    if (this.kept.size > MAX_CHAT_ENTRIES) {
      const first = this.kept.keys().next().value as string;
      this.kept.delete(first);
    }
  }

  /** The cursor the SSE stream resumes after (`Last-Event-ID` / `?cursor=`): the newest durable entry's. */
  resumeCursor(): string | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = (this.list[i] as ChatEntry).cursor;
      if (c !== undefined) return c;
    }
    return undefined;
  }

  /** The cursor that loads the entries before the window, if there are any and there is room. */
  olderCursor(): string | undefined {
    return this.value().older;
  }

  // ── folding ────────────────────────────────────────────────────────────────────────────────

  /**
   * A history page (`GET .../history`): `{ entries, nextCursor?, done, closed? }`. `backward`
   * pages arrive newest first (initial load, "load earlier"); `forward` pages oldest first (catch-up
   * after a gap). A malformed page changes nothing. `direction` MUST be the one the page was fetched
   * with: loom's history route defaults to `forward` (oldest first) when the query has no
   * `direction`, so a page fetched without it and folded as `backward` comes out reversed.
   */
  applyHistory(page: unknown, direction: "backward" | "forward"): ChatFeedResult {
    if (!isRecord(page)) return refuse("history-invalid", "a history page is { entries, done }");
    const entries = own(page, "entries");
    if (!Array.isArray(entries) || entries.length > MAX_CHAT_ENTRIES)
      return refuse("history-invalid", "a history page holds a bounded list of entries");
    const done = own(page, "done");
    const next = own(page, "nextCursor");
    let changed = false;
    // Newest first for a backward page: the entries closest to the window go in first, so if the
    // window fills, what is kept is contiguous with it.
    for (const raw of entries) {
      const entry = chatEntryFromWire(raw);
      if (entry === undefined) continue;
      if (direction === "backward" && !this.hasRoomFor(entry)) break;
      changed = this.upsert(entry) || changed;
    }
    if (direction === "backward") {
      if (done === true) {
        if (!this.startReached) changed = true;
        this.startReached = true;
        this.older = undefined;
      } else if (isChatCursor(next)) {
        // The oldest entry we hold is the boundary the next page must start before.
        const oldest = this.list.find((e) => e.cursor !== undefined)?.cursor;
        const boundary =
          oldest !== undefined && compareChatCursors(oldest, next) < 0 ? oldest : next;
        if (this.older !== boundary) changed = true;
        this.older = boundary;
      }
    }
    if (own(page, "closed") === true && this.state !== "closed") {
      this.state = "closed";
      this.running = false;
      changed = true;
    }
    return this.finish(changed);
  }

  /**
   * One SSE event: `name` is the `event:` field, `data` the PARSED JSON of the `data:` line. Never
   * throws, whatever `data` is. An `error` event is reported with FIXED text; its body is never
   * read. `reconnect` asks the host to reopen the stream from {@link resumeCursor}.
   */
  applyEvent(name: string, data: unknown): ChatFeedResult {
    switch (name) {
      case "message": {
        const entry = chatEntryFromWire(data);
        if (entry === undefined)
          return refuse("message-invalid", "a message event is a conversation entry");
        return this.finish(this.upsert(entry));
      }
      case "status": {
        if (!isRecord(data)) return refuse("status-invalid", "a status event is an object");
        let changed = false;
        const st = own(data, "state");
        const next = st === "open" ? "open" : typeof st === "string" ? "closed" : this.state;
        if (next !== this.state) {
          this.state = next;
          changed = true;
        }
        const run = own(data, "running");
        if (typeof run === "boolean" && run !== this.running) {
          this.running = run;
          changed = true;
        }
        if (this.state === "closed") {
          changed = this.dropLive() || changed;
          if (this.liveReasoning !== undefined) {
            this.liveReasoning = undefined;
            changed = true;
          }
        }
        return this.finish(changed);
      }
      case "partial":
      case "delta": {
        if (!isRecord(data)) return refuse("delta-invalid", "a delta event is { turn, text }");
        const turn = own(data, "turn");
        const text = own(data, "text");
        if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1)
          return refuse("delta-invalid", "a delta event is { turn, text }");
        if (typeof text !== "string")
          return refuse("delta-invalid", "a delta event is { turn, text }");
        return this.finish(this.applyLive(turn, text, name === "partial"));
      }
      case "reasoning":
      case "reasoning-partial": {
        // Off (the default): not even a finding. The server only sends it to a host that opted in.
        if (!this.reasoningOn) return NOOP;
        if (!isRecord(data))
          return refuse("reasoning-invalid", "a reasoning event is { turn, text }");
        const turn = own(data, "turn");
        const text = own(data, "text");
        if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1)
          return refuse("reasoning-invalid", "a reasoning event is { turn, text }");
        if (typeof text !== "string")
          return refuse("reasoning-invalid", "a reasoning event is { turn, text }");
        return this.finish(this.applyLiveReasoning(turn, text, name === "reasoning-partial"));
      }
      case "reset": {
        const turn = isRecord(data) ? own(data, "turn") : undefined;
        if (typeof turn !== "number") return refuse("delta-invalid", "a reset event is { turn }");
        // A re-run of the turn supersedes the reply AND its reasoning.
        let cleared = false;
        if (this.live?.turn === turn) cleared = this.dropLive();
        if (this.liveReasoning?.turn === turn) {
          this.liveReasoning = undefined;
          cleared = true;
        }
        return this.finish(cleared);
      }
      case "closed": {
        const reasoningWas = this.liveReasoning !== undefined;
        const changed = this.state !== "closed" || this.live !== undefined || this.running;
        this.state = "closed";
        this.running = false;
        this.live = undefined;
        this.liveReasoning = undefined;
        return this.finish(changed || reasoningWas);
      }
      case "reconnect":
        return { ok: true, changed: false, reconnect: true };
      case "error":
        // The body of an `error` event is the server's; it is not read, let alone shown.
        return refuse("stream-error", "the conversation stream reported an error");
      default:
        return refuse("event-unknown", "an unknown conversation event was ignored");
    }
  }

  /**
   * Label a turn the HOST knows is an edit of an earlier one. Append-only: this changes how the
   * turn is DRAWN, never what the log holds. Refused for a turn that is not later than `editOf`.
   */
  annotate(turn: number, label: { readonly editOf: number }): ChatFeedResult {
    const { editOf } = label;
    if (
      !Number.isSafeInteger(turn) ||
      !Number.isSafeInteger(editOf) ||
      editOf < 1 ||
      turn <= editOf
    )
      return refuse(
        "annotate-invalid",
        "an edit labels a later turn with the earlier turn it revises"
      );
    if (this.edits.get(turn) === editOf) return NOOP;
    if (!this.edits.has(turn) && this.edits.size >= MAX_CHAT_ENTRIES) {
      const first = this.edits.keys().next().value as number;
      this.edits.delete(first);
    }
    this.edits.set(turn, editOf);
    return this.finish(true);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  private finish(changed: boolean): ChatFeedResult {
    if (!changed) return NOOP;
    this.snapshot = undefined;
    return CHANGED;
  }

  private hasRoomFor(entry: ChatEntry): boolean {
    return this.index.has(entry.id) || this.list.length < this.cap;
  }

  private liveEntry(): ChatEntry | undefined {
    const l = this.live?.stream.text === "" ? undefined : this.live;
    const r = this.liveReasoning?.text === "" ? undefined : this.liveReasoning;
    // The reply and its reasoning share the turn's slot; a reasoning with no reply text yet still makes
    // the streaming reply (the model thinks before it speaks).
    const turn = l !== undefined && (r === undefined || l.turn >= r.turn) ? l.turn : r?.turn;
    if (turn === undefined) return undefined;
    if (this.index.has(entryId(turn, "assistant"))) return undefined;
    const text = l?.turn === turn ? l.stream.text : "";
    const reasoning = r?.turn === turn ? r : undefined;
    return {
      id: entryId(turn, "assistant"),
      turn,
      role: "assistant",
      status: "streaming",
      ...(text !== "" && { parts: [{ type: "text", text }] }),
      ...(reasoning !== undefined && {
        reasoning: {
          text: reasoning.text,
          kind: this.liveKind,
          streaming: true,
          ...(reasoning.truncated && { truncated: true }),
        },
      }),
    };
  }

  private dropLive(): boolean {
    if (this.live === undefined) return false;
    this.live = undefined;
    return true;
  }

  private applyLiveReasoning(turn: number, text: string, replace: boolean): boolean {
    if (!this.mayShowLive(turn, true)) return false;
    const newest = Math.max(this.live?.turn ?? 0, this.liveReasoning?.turn ?? 0);
    if (turn < newest) return false; // a stale turn
    // A newer turn supersedes the older turn's live text (it is not that turn's reply any more).
    if (this.live !== undefined && this.live.turn < turn) this.live = undefined;
    if (this.liveReasoning === undefined || this.liveReasoning.turn !== turn || replace) {
      // A new turn, or the catch-up partial: the reasoning restarts from this text (so a reconnect cannot duplicate it).
      this.liveReasoning = { turn, text: "", truncated: false };
    }
    const cur = this.liveReasoning;
    const before = cur.text;
    for (let i = 0; i < text.length && !cur.truncated; i += MAX_CHUNK_TEXT) {
      // Untrusted model output: cleaned per chunk as it lands, exactly like reply text.
      const room = MAX_CHAT_REASONING_TEXT - cur.text.length;
      const piece = text.slice(i, i + MAX_CHUNK_TEXT);
      const chunk = sanitizeChatText(
        piece.length > room ? piece.slice(0, room) : piece,
        MAX_CHUNK_TEXT
      );
      cur.text += chunk;
      if (piece.length > room || cur.text.length >= MAX_CHAT_REASONING_TEXT) cur.truncated = true;
    }
    return cur.text !== before || replace;
  }

  /** May live text for `turn` be shown to THIS viewer? Fail closed on what the client can see. */
  private mayShowLive(turn: number, reasoning = false): boolean {
    if (this.index.has(entryId(turn, "assistant"))) return false; // the durable reply won
    // Bound to the turn's ACCEPTED question: a rejected envelope on the same number is not the asker.
    const qid = this.acceptedUser.get(turn);
    const q = qid === undefined ? undefined : this.list[this.index.get(qid) ?? -1];
    if (q === undefined) return true; // the question has not arrived yet; the server only sends it to the asker
    if (q.status === "restricted") return false;
    // Reasoning is not filtered by asker here: the server sends it to the asker and the owner (ADR 0133 D6).
    if (
      !reasoning &&
      this.viewer !== undefined &&
      q.asker !== undefined &&
      !sameChatActor(q.asker, this.viewer)
    )
      return false;
    return true;
  }

  private applyLive(turn: number, text: string, replace: boolean): boolean {
    if (!this.mayShowLive(turn)) return false;
    if (this.live !== undefined && turn < this.live.turn) return false; // a stale turn
    if (this.liveReasoning !== undefined && this.liveReasoning.turn < turn)
      this.liveReasoning = undefined;
    if (this.live === undefined || this.live.turn !== turn || replace) {
      // A new turn, or a catch-up `partial`: the stream restarts from this text (bounded).
      this.live = { turn, stream: { text: "", nextSeq: 0, done: false } };
    }
    const live = this.live;
    let changed = false;
    for (let i = 0; i < text.length; i += MAX_CHUNK_TEXT) {
      // Untrusted: the text is cleaned PER CHUNK as it lands (controls cannot assemble across
      // chunks into anything the sanitiser would have refused: it removes characters, never adds).
      const chunk = sanitizeChatText(text.slice(i, i + MAX_CHUNK_TEXT), MAX_CHUNK_TEXT);
      const r = appendChunk(live.stream, { seq: live.stream.nextSeq, text: chunk });
      if (!r.ok) break; // full: keep what we have; the durable reply is the record
      live.stream = r.state;
      changed = changed || chunk !== "";
    }
    return changed;
  }

  /** Insert or (rarely) replace a durable entry. Returns whether the value changed. */
  private upsert(incoming: ChatEntry): boolean {
    // One log position is one entry, however the source keyed it: an entry seen first by position and
    // later with a record id (or the reverse) is the SAME entry and keeps the id it was first seen under.
    const known = incoming.cursor === undefined ? undefined : this.byCursor.get(incoming.cursor);
    const entry =
      known !== undefined && known !== incoming.id ? { ...incoming, id: known } : incoming;
    const at = this.index.get(entry.id);
    if (at !== undefined) {
      const have = this.list[at] as ChatEntry;
      // Immutable once visible; a placeholder may become the real thing, never the reverse.
      if (have.status !== "restricted" || entry.status === "restricted") return false;
      this.list[at] = entry;
    } else {
      if (this.list.length >= this.cap && !this.makeRoomForTail(entry)) return false;
      insertSorted(this.list, entry);
      this.reindex();
    }
    this.afterDurable(entry);
    return true;
  }

  /** A tail arrival at a full window drops the OLDEST entry; an entry older than the window's start is refused. */
  private makeRoomForTail(entry: ChatEntry): boolean {
    const first = this.list[0] as ChatEntry;
    if (compareEntries(entry, first) < 0) return false;
    this.list.shift();
    // The dropped entry's position is where "load earlier" now starts.
    const boundary = (this.list[0] as ChatEntry | undefined)?.cursor;
    if (boundary !== undefined) {
      this.older = boundary;
      this.startReached = false;
    }
    return true;
  }

  private reindex(): void {
    this.index = new Map(this.list.map((e, i) => [e.id, i] as const));
    this.byCursor = new Map(
      this.list.flatMap((e) => (e.cursor === undefined ? [] : [[e.cursor, e.id] as const]))
    );
    this.acceptedUser = new Map(
      this.list
        .filter((e) => e.role === "user" && e.status !== "rejected")
        .map((e) => [e.turn, e.id] as const)
    );
  }

  private afterDurable(entry: ChatEntry): void {
    if (entry.role === "assistant" && this.live?.turn === entry.turn) this.live = undefined;
    if (entry.role === "assistant" && this.liveReasoning?.turn === entry.turn) {
      // The durable reply is final: the live reasoning becomes THAT reply's reasoning (a bare placeholder keeps none).
      const r = this.liveReasoning;
      this.liveReasoning = undefined;
      if (this.reasoningOn && entry.status !== "restricted" && r.text !== "")
        this.remember(entry.id, {
          text: r.text,
          kind: this.liveKind,
          streaming: false,
          ...(r.truncated && { truncated: true }),
        });
    }
    // Live text shown before its question arrived (or was upgraded) is retracted if the question says it
    // is not this viewer's to see: a restricted question, or another asker's.
    if (entry.role === "user") {
      if (!this.mayShowLive(entry.turn) && this.live?.turn === entry.turn) this.live = undefined;
      if (!this.mayShowLive(entry.turn, true) && this.liveReasoning?.turn === entry.turn)
        this.liveReasoning = undefined;
    }
    if (entry.role === "assistant") this.running = false;
    else if (entry.status === "complete") this.running = true;
  }
}

/** Log order: by cursor when both have one; by turn and role otherwise (the live reply has no cursor). */
function compareEntries(a: ChatEntry, b: ChatEntry): number {
  if (a.cursor !== undefined && b.cursor !== undefined) {
    const c = compareChatCursors(a.cursor, b.cursor);
    if (c !== 0) return c;
  }
  // Without positions a refused envelope sorts before the turn it shares a number with (that is
  // the order loom records them in).
  const refused = (e: ChatEntry): number => (e.status === "rejected" ? 0 : 1);
  return a.turn - b.turn || ROLE_RANK[a.role] - ROLE_RANK[b.role] || refused(a) - refused(b);
}

/** Insert into a (turn, role)-sorted list by binary search. Replaces nothing. */
function insertSorted(list: ChatEntry[], entry: ChatEntry): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEntries(list[mid] as ChatEntry, entry) < 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, entry);
}

/**
 * A `ChatValue` straight from one history page, for the SERVER side: a host effect that wraps
 * `Conversations.history` (already filtered for the viewer by loom) returns this, and a hydration
 * provider of kind `loom-effect` binds it to a `Chat` widget for the first paint / a split-hydration
 * payload, with the browser's `connectConversation` taking over afterwards. Exactly the fold a
 * browser runs (the same wire parsing, sanitising, bare placeholders, bounds), so the two cannot
 * disagree. `direction` is the page's own (default `backward`: the newest page, which is what a first
 * paint fetches). Fetch it with `?direction=backward`: loom's route defaults to `forward` (oldest
 * first) when `direction` is omitted, and a forward page folded as `backward` comes out reversed.
 * A malformed page is an empty transcript, never a throw.
 */
export function chatValueFromHistory(
  page: unknown,
  options: ChatFeedOptions & { readonly direction?: "backward" | "forward" } = {}
): ChatValue {
  const feed = new ChatFeed(options);
  feed.applyHistory(page, options.direction ?? "backward");
  return feed.value();
}
