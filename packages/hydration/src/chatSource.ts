import type { Finding } from "@loom-ui/core/browser";
import type { ChatFeed } from "@loom-ui/core/chat";

// ── The browser's connection to loom's conversation API (U8) ─────────────────────────────────────
//
// `@loom/plugin-conversation-sse` (ADR 0122) serves a conversation over two routes this connects:
//
//     GET {baseUrl}/history?direction=backward&limit=N[&cursor=C]    a bounded page, newest first
//     GET {baseUrl}/events[?cursor=C]                                text/event-stream (SSE)
//     GET {baseUrl}/reasoning?cursor=<reply cursor>                  one reply's stored reasoning (opt-in, lazy)
//
// REASONING (loom ADR 0133 D6) is opt-in on the server AND on the feed (`ChatFeed({ reasoning })`). This
// file only routes: the `reasoning` / `reasoning-partial` events go to the feed (which ignores them unless
// the host turned reasoning on), and `loadReasoning(cursor)` fetches ONE reply's durable reasoning, only
// when the host asks (a Chat's `LOAD_REASONING` action, i.e. the reader expanded it), never for the whole
// history. The body is folded by the feed; a 404 (the server's answer for every reason) is "none kept".
//
// and the sends go the other way through the host's write-back (`conversationTarget`), NOT through
// this file: a submit is an authenticated, signed action the host validates (`acceptChatSubmit`);
// this is the read half. It folds what arrives into a {@link ChatFeed} and publishes the resulting
// `ChatValue` through `publish` (usually `publishChat(store, handle)`), so a Chat widget bound to
// that handle just draws it.
//
// NOTHING OF LOOM RUNS HERE. The transport is injected: `fetch` for history, `openStream` for the
// event stream (the host builds the `EventSource` with its own credentials / `withCredentials`; an
// `EventSource` cannot send an Authorization header, which is why this takes a factory). This file
// imports no loom package and no Node module, so it is part of the browser entry.
//
// Failures are FIXED findings: a status code, a response body or an exception message is never
// carried (a 404 for "no such conversation" and "not yours" is the same on purpose, ADR 0122 D6).
// Frames over `maxFrameBytes` and non-JSON frames are dropped with a finding; the feed validates
// everything else.

/** The slice of the platform's `EventSource` this uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  close(): void;
  /** 2 = CLOSED: the platform gave up reconnecting and we must reopen. */
  readonly readyState?: number;
}
export interface FetchResponseLike {
  readonly ok: boolean;
  /** The HTTP status, when the host's `fetch` has one: a 403/404 on the reasoning route means "none for you". */
  readonly status?: number;
  json(): Promise<unknown>;
  /**
   * The body as text, when the host's fetch has it. The reasoning read prefers it: the size is checked
   * before `JSON.parse`. Without it the read falls back to `json()`, which the host's own fetch must bound.
   */
  text?(): Promise<string>;
  /** Response headers, when the host exposes them: a declared `Content-Length` over the limit refuses the read. */
  readonly headers?: { get(name: string): string | null };
}

/**
 * The most a durable reasoning response may weigh (bytes, or characters for the `text()` check). loom's
 * route caps the readable text at 1 MiB, so 2 MiB leaves room for the JSON envelope and escaping.
 * Residual: a host `fetch` that only offers `json()` and sends no `Content-Length` is not bounded here.
 */
export const MAX_REASONING_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ConversationConnectionOptions {
  /** `/conversations/<id>` (or absolute). The id was minted by the server; this appends `/history` and `/events`. */
  readonly baseUrl: string;
  readonly fetch: (
    url: string,
    init: { readonly signal: AbortSignal }
  ) => Promise<FetchResponseLike>;
  /** Open the SSE stream at `url` (the host owns credentials). */
  readonly openStream: (url: string) => EventSourceLike;
  readonly feed: Pick<
    ChatFeed,
    "applyHistory" | "applyEvent" | "resumeCursor" | "olderCursor" | "value" | "streaming"
  > &
    Partial<
      Pick<
        ChatFeed,
        "beginReasoning" | "applyReasoning" | "reasoningFailed" | "reasoningUnavailable"
      >
    >;
  /**
   * The server serves `/reasoning` (loom's `reasoning: { store }`) and the feed is `reasoning: { durable: true }`:
   * `loadReasoning` then fetches. Default false: `loadReasoning` does nothing.
   */
  readonly reasoning?: boolean;
  /** Called with the new value after every change. Deltas arrive fast: throttle here if the host wants. */
  readonly publish: (
    value: ReturnType<ChatFeed["value"]>,
    meta: { readonly streaming: boolean }
  ) => void;
  /** Fixed-text findings (a failed load, a bad frame). */
  readonly onFinding?: (finding: Finding) => void;
  /** Entries per history page (default 50, loom caps it at 500). */
  readonly pageLimit?: number;
  /** Largest SSE frame parsed, bytes of text (default 256 KiB). */
  readonly maxFrameBytes?: number;
  /** First delay after a failure, ms (default 2 000); it doubles per consecutive failure up to `maxReconnectMs`. */
  readonly reconnectMs?: number;
  /** The longest delay between attempts, ms (default 30 000). */
  readonly maxReconnectMs?: number;
  /**
   * The shortest delay before reopening a stream the server asked to recycle (`reconnect`), ms
   * (default 250). Never 0: a server that answered `reconnect` at once would be a hot loop.
   */
  readonly reconnectFloorMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface ConversationConnection {
  /** Load the newest page, then open the stream from where it ended. Resolves when the first page is in. */
  start(): Promise<void>;
  /** Load the page before the window (no-op when there is none or one is in flight). */
  loadOlder(): Promise<void>;
  /**
   * Fetch the stored reasoning of the reply at `cursor` (the entry's own cursor), once: a no-op unless
   * `reasoning` is on, the feed offers that reply, and it is not already loaded or loading.
   */
  loadReasoning(cursor: string): Promise<void>;
  /** Stop everything. Idempotent. */
  close(): void;
}

/** A stream open at least this long (ms) was healthy: its end is not a failure streak. */
const HEALTHY_MS = 5000;
const EVENTS = [
  "status",
  "partial",
  "delta",
  "reasoning",
  "reasoning-partial",
  "reset",
  "message",
  "closed",
  "reconnect",
  "error",
];
const changedBy = (r: { readonly ok: boolean; readonly changed?: boolean } | undefined): boolean =>
  r?.ok === true && r.changed === true;
const finding = (code: string, message: string): Finding => ({ code, severity: "error", message });

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function connectConversation(
  options: ConversationConnectionOptions
): ConversationConnection {
  const { feed, baseUrl } = options;
  const pageLimit = Math.max(1, Math.min(options.pageLimit ?? 50, 500));
  const maxFrame = options.maxFrameBytes ?? 256 * 1024;
  const timer = options.setTimer ?? defaultTimer;
  const ac = new AbortController();
  let source: EventSourceLike | undefined;
  let cancelReopen: (() => void) | undefined;
  let closed = false;
  let loadingOlder = false;
  let failures = 0;
  let openedAt = 0;
  const now = options.now ?? Date.now;
  const base = Math.max(1, options.reconnectMs ?? 2000);
  const ceiling = Math.max(base, options.maxReconnectMs ?? 30_000);
  const floor = Math.max(1, options.reconnectFloorMs ?? 250);
  /** Consecutive failures double the wait, capped; the first is the base. */
  const backoff = (): number => Math.min(ceiling, base * 2 ** Math.min(failures, 16));

  const report = (code: string, message: string): void =>
    options.onFinding?.(finding(code, message));
  const publish = (): void => options.publish(feed.value(), { streaming: feed.streaming });

  async function page(cursor?: string): Promise<boolean> {
    const q = `direction=backward&limit=${pageLimit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    let body: unknown;
    try {
      const res = await options.fetch(`${baseUrl}/history?${q}`, { signal: ac.signal });
      if (!res.ok) throw new Error("not ok");
      body = await res.json();
    } catch {
      if (!ac.signal.aborted)
        report("history-unavailable", "the conversation history could not be loaded");
      return false;
    }
    if (closed) return false;
    const r = feed.applyHistory(body, "backward");
    if (!r.ok) {
      report(r.finding.code, r.finding.message);
      return false;
    }
    if (r.changed) publish();
    return true;
  }

  function open(): void {
    if (closed) return;
    const cursor = feed.resumeCursor();
    const url = `${baseUrl}/events${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`;
    const es = options.openStream(url);
    source = es;
    openedAt = now();
    for (const name of EVENTS)
      es.addEventListener(name, (ev) => {
        if (closed || source !== es) return;
        const raw = ev.data;
        let data: unknown;
        if (typeof raw === "string") {
          if (raw.length > maxFrame)
            return report("frame-too-large", "a conversation event was too large and was ignored");
          try {
            data = JSON.parse(raw);
          } catch {
            return report(
              "frame-invalid",
              "a conversation event was not understood and was ignored"
            );
          }
        }
        const r = feed.applyEvent(name, data);
        if (!r.ok) {
          // The feed's finding text is fixed; an `error` event's body was never read.
          report(r.finding.code, r.finding.message);
          return;
        }
        if (r.reconnect !== true) failures = 0; // a frame the feed understood: the connection works
        if (r.changed) publish();
        if (r.reconnect === true) {
          // Asked to recycle. A server that does so right after opening is looping: back off like a failure.
          const healthy = now() - openedAt >= HEALTHY_MS;
          if (healthy) failures = 0;
          reopen(failures === 0 ? floor : Math.max(floor, backoff()));
          if (!healthy) failures++;
        }
      });
    // A stream the platform has given up on (it keeps trying by itself while CONNECTING).
    (es as { onerror?: () => void }).onerror = () => {
      if (es.readyState === 2) {
        // A stream that stayed up long enough was healthy: its end starts the backoff afresh, and the
        // first wait is the documented base.
        if (now() - openedAt >= HEALTHY_MS) failures = 0;
        const delay = backoff();
        failures++;
        reopen(delay);
      }
    };
  }

  function reopen(delay: number): void {
    if (closed) return;
    source?.close();
    source = undefined;
    cancelReopen?.();
    cancelReopen = timer(() => {
      cancelReopen = undefined;
      open();
    }, delay);
  }

  /** The first page; on failure (and nothing to show) try again after a backoff instead of giving up. */
  async function begin(): Promise<void> {
    const ok = await page();
    if (closed) return;
    if (ok || feed.value().entries.length > 0) {
      if (ok) failures = 0;
      open();
      return;
    }
    const delay = backoff();
    failures++;
    cancelReopen?.();
    cancelReopen = timer(() => {
      cancelReopen = undefined;
      void begin();
    }, delay);
  }

  const loadingReasoning = new Set<string>();
  async function reasoningFor(cursor: string): Promise<void> {
    const { feed: f } = options;
    if (options.reasoning !== true || closed || loadingReasoning.has(cursor)) return;
    if (f.beginReasoning === undefined || !changedBy(f.beginReasoning(cursor))) return;
    loadingReasoning.add(cursor);
    publish(); // the entry now reads "loading"
    try {
      let body: unknown;
      let gone = false;
      try {
        const res = await options.fetch(
          `${baseUrl}/reasoning?cursor=${encodeURIComponent(cursor)}`,
          {
            signal: ac.signal,
          }
        );
        if (!res.ok) {
          gone = res.status === 404 || res.status === 403;
          throw new Error("not ok");
        }
        const declared = Number(res.headers?.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_REASONING_RESPONSE_BYTES)
          throw new Error("too large");
        if (res.text !== undefined) {
          const raw = await res.text();
          if (raw.length > MAX_REASONING_RESPONSE_BYTES) throw new Error("too large");
          body = JSON.parse(raw);
        } else body = await res.json();
      } catch {
        if (closed) return;
        // A refusal is a settled "none for you" (no retry); anything else is a failure the reader can retry.
        if (gone) f.reasoningUnavailable?.(cursor);
        else {
          f.reasoningFailed?.(cursor);
          report("reasoning-unavailable", "the reasoning could not be loaded");
        }
        publish();
        return;
      }
      if (closed) return;
      if (changedBy(f.applyReasoning?.(cursor, body))) publish();
    } finally {
      loadingReasoning.delete(cursor);
    }
  }

  return {
    start: begin,
    loadReasoning: reasoningFor,
    async loadOlder() {
      const cursor = feed.olderCursor();
      if (cursor === undefined || loadingOlder || closed) return;
      loadingOlder = true;
      try {
        await page(cursor);
      } finally {
        loadingOlder = false;
      }
    },
    close() {
      closed = true;
      ac.abort();
      cancelReopen?.();
      source?.close();
      source = undefined;
    },
  };
}

/** What a hydration controller offers for a value no loader serves (`publishValue`): its viewer / inventory gate and contract check. */
export interface ValuePublisher {
  publishValue(
    handle: string,
    value: unknown,
    options: { readonly state: "ready" | "pending"; readonly kind: string }
  ): { readonly ok: true } | { readonly ok: false; readonly finding: Finding };
}

/**
 * A `publish` that writes the transcript to a handle THROUGH a controller's gate (`publishValue`):
 * refused (a finding, nothing written) for a handle the experience does not bind, one that is
 * restricted for the viewer, one that is not a `Chat`, or a value that fails the `ChatValue`
 * contract. `pending` while a reply streams (a screen reader holds its announcements), `ready` once
 * it is durable. Writing the store directly would bypass all of that.
 */
export function publishChat(
  controller: ValuePublisher,
  handle: string,
  onFinding?: (finding: Finding) => void
): (value: unknown, meta: { readonly streaming: boolean }) => void {
  return (value, meta) => {
    const r = controller.publishValue(handle, value, {
      state: meta.streaming ? "pending" : "ready",
      kind: "Chat",
    });
    if (!r.ok) onFinding?.(r.finding);
  };
}
