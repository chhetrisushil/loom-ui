import type { Finding } from "@loom-ui/core";
import type { ChangeEvent, ChangeFeed } from "./feed";

// ── Unread: what a viewer has not yet seen ────────────────────────────────────
// A cursor per (viewer, experience): the last feed `sequence` the viewer has acknowledged. Unread
// is everything after it. The cursor only moves FORWARD and is clamped to the log's tip, so a
// replayed acknowledgement is harmless (idempotent) and a viewer cannot pre-read the future.
//
// `viewerId` is the caller's claim: this package performs no authentication or authorization (the
// host resolves who the viewer is, and what they may see, before it calls here).

export interface UnreadStore {
  /** The viewer's cursor for the line; 0 when none was ever recorded. */
  get(viewerId: string, experienceId: string): Promise<number>;
  /**
   * Move the cursor to `max(current, to)` and return the result. A `to` that is not a non-negative
   * safe integer changes nothing. Atomic against concurrent advances: the cursor never goes back.
   */
  advance(viewerId: string, experienceId: string, to: number): Promise<number>;
}

export class InMemoryUnreadStore implements UnreadStore {
  // Nested maps, not a joined key: no separator a viewer or experience id could contain.
  private readonly cursors = new Map<string, Map<string, number>>();

  async get(viewerId: string, experienceId: string): Promise<number> {
    return this.cursors.get(viewerId)?.get(experienceId) ?? 0;
  }

  async advance(viewerId: string, experienceId: string, to: number): Promise<number> {
    const current = this.cursors.get(viewerId)?.get(experienceId) ?? 0;
    if (!Number.isSafeInteger(to) || to <= current) return current;
    let mine = this.cursors.get(viewerId);
    if (mine === undefined) {
      mine = new Map();
      this.cursors.set(viewerId, mine);
    }
    mine.set(experienceId, to);
    return to;
  }
}

export type UnreadResult =
  | {
      readonly ok: true;
      readonly events: readonly ChangeEvent[];
      /** The viewer's cursor when read. */
      readonly cursor: number;
      /** More unread events exist past this page. */
      readonly more: boolean;
    }
  | { readonly ok: false; readonly finding: Finding };

/** The events the viewer has not acknowledged, oldest first, one page. */
export async function unreadChanges(
  feed: ChangeFeed,
  store: UnreadStore,
  viewerId: string,
  experienceId: string,
  opts: { limit?: number } = {}
): Promise<UnreadResult> {
  const cursor = await store.get(viewerId, experienceId);
  const r = await feed.read(experienceId, {
    after: cursor,
    ...(opts.limit !== undefined && { limit: opts.limit }),
  });
  return r.ok ? { ok: true, events: r.events, cursor, more: r.more } : r;
}

/**
 * Acknowledge everything through `through` (clamped to the log's tip). Returns the new cursor, or
 * the finding when the line could not be read (then nothing moves).
 */
export async function markRead(
  feed: ChangeFeed,
  store: UnreadStore,
  viewerId: string,
  experienceId: string,
  through: number
): Promise<{ ok: true; cursor: number } | { ok: false; finding: Finding }> {
  const r = await feed.read(experienceId, { limit: 1, after: Number.MAX_SAFE_INTEGER });
  if (!r.ok) return r;
  if (!Number.isSafeInteger(through) || through < 0)
    return { ok: true, cursor: await store.get(viewerId, experienceId) };
  return {
    ok: true,
    cursor: await store.advance(viewerId, experienceId, Math.min(through, r.tip)),
  };
}
