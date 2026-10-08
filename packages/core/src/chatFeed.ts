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
//    only (ADR 0122 D10.4), and this is the client's second line.
//  - BOUNDED. At most `maxEntries` entries (default and ceiling {@link MAX_CHAT_ENTRIES}); the live
//    reply is bounded like any stream (`appendChunk`: 64 K, closed on overflow).
//  - EDITS ARE NEW TURNS. `annotate(turn, { editOf })` labels a turn the host KNOWS is an edit; the
//    feed never infers one (loom's record has no such field today, see the README).

import { sanitizeChatText } from "./chatText";
import { type ChatActor, type ChatEntry, type ChatValue, MAX_CHAT_ENTRIES } from "./chatValue";
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

const ROLE_RANK = { user: 0, assistant: 1, system: 2 } as const;
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
  if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1) return undefined;
  if (role !== "user" && role !== "assistant") return undefined;
  const rawStatus = own(raw, "status");
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
  return {
    id: entryId(turn, role),
    turn,
    role,
    status,
    ...(text !== "" && { parts: [{ type: "text", text }] }),
    ...(asker !== undefined && { asker }),
    ...(isChatCursor(cursor) && { cursor }),
    ...(typeof at === "number" && Number.isFinite(at) && at >= 0 && { at }),
    ...(!bare && isChatReason(reason) && { reason }),
    ...(!bare && isChatErrorId(errorId) && { errorId }),
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
}

interface Live {
  readonly turn: number;
  stream: StreamedText;
}

export class ChatFeed {
  private readonly viewer: ChatActor | undefined;
  private readonly max: number;
  /** Durable entries, sorted by (turn, role). */
  private list: ChatEntry[] = [];
  private index = new Map<string, number>();
  private live: Live | undefined;
  private older: string | undefined;
  private startReached = false;
  private state: "open" | "closed" = "open";
  private running = false;
  private readonly edits = new Map<number, number>();
  private snapshot: ChatValue | undefined;

  constructor(options: ChatFeedOptions = {}) {
    this.viewer = options.viewer;
    this.max = Math.max(1, Math.min(options.maxEntries ?? MAX_CHAT_ENTRIES, MAX_CHAT_ENTRIES));
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────

  /** The transcript to publish to the widget's handle. The same object until something changes. */
  value(): ChatValue {
    if (this.snapshot !== undefined) return this.snapshot;
    const entries: ChatEntry[] = this.list.map((e) => {
      const editOf = this.edits.get(e.turn);
      return e.role === "user" && editOf !== undefined && e.editOf === undefined
        ? { ...e, editOf }
        : e;
    });
    const live = this.liveEntry();
    if (live !== undefined) insertSorted(entries, live);
    const older = this.startReached || entries.length >= this.max ? undefined : this.older;
    this.snapshot = {
      entries,
      ...(this.viewer !== undefined && { viewer: this.viewer }),
      ...(older !== undefined && { older }),
      state: this.state,
      running: this.running || live !== undefined,
    };
    return this.snapshot;
  }

  /** Is a reply streaming right now? (Drives the binding status: `pending` while true.) */
  get streaming(): boolean {
    return this.liveEntry() !== undefined;
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
   * after a gap). A malformed page changes nothing.
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
        if (this.state === "closed") changed = this.dropLive() || changed;
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
      case "reset": {
        const turn = isRecord(data) ? own(data, "turn") : undefined;
        if (typeof turn !== "number") return refuse("delta-invalid", "a reset event is { turn }");
        if (this.live?.turn !== turn) return NOOP;
        return this.finish(this.dropLive());
      }
      case "closed": {
        const changed = this.state !== "closed" || this.live !== undefined || this.running;
        this.state = "closed";
        this.running = false;
        this.live = undefined;
        return this.finish(changed);
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
    return this.index.has(entry.id) || this.list.length < this.max;
  }

  private liveEntry(): ChatEntry | undefined {
    const l = this.live;
    if (l === undefined || l.stream.text === "") return undefined;
    if (this.index.has(entryId(l.turn, "assistant"))) return undefined;
    return {
      id: entryId(l.turn, "assistant"),
      turn: l.turn,
      role: "assistant",
      status: "streaming",
      parts: [{ type: "text", text: l.stream.text }],
    };
  }

  private dropLive(): boolean {
    if (this.live === undefined) return false;
    this.live = undefined;
    return true;
  }

  /** May live text for `turn` be shown to THIS viewer? Fail closed on what the client can see. */
  private mayShowLive(turn: number): boolean {
    if (this.index.has(entryId(turn, "assistant"))) return false; // the durable reply won
    const q = this.list[this.index.get(entryId(turn, "user")) ?? -1];
    if (q === undefined) return true; // the question has not arrived yet; the server only sends it to the asker
    if (q.status === "restricted") return false;
    if (this.viewer !== undefined && q.asker !== undefined && !sameChatActor(q.asker, this.viewer))
      return false;
    return true;
  }

  private applyLive(turn: number, text: string, replace: boolean): boolean {
    if (!this.mayShowLive(turn)) return false;
    if (this.live !== undefined && turn < this.live.turn) return false; // a stale turn
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
  private upsert(entry: ChatEntry): boolean {
    const at = this.index.get(entry.id);
    if (at !== undefined) {
      const have = this.list[at] as ChatEntry;
      // Immutable once visible; a placeholder may become the real thing, never the reverse.
      if (have.status !== "restricted" || entry.status === "restricted") return false;
      this.list[at] = entry;
    } else {
      if (this.list.length >= this.max && !this.makeRoomForTail(entry)) return false;
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
  }

  private afterDurable(entry: ChatEntry): void {
    if (entry.role === "assistant" && this.live?.turn === entry.turn) this.live = undefined;
    if (entry.role === "assistant") this.running = false;
    else if (entry.status === "complete") this.running = true;
  }
}

function compareEntries(a: ChatEntry, b: ChatEntry): number {
  return a.turn - b.turn || ROLE_RANK[a.role] - ROLE_RANK[b.role];
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
