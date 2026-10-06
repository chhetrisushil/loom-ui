// ── "This experience has a new head" ──────────────────────────────────────────
// The seam a renderer (or any reader) uses to learn that an experience moved, WITHOUT knowing how
// the host finds out: a poll over a lineage store, a push over an event log, a websocket the app
// owns. Types only, so a browser bundle can implement it with a `fetch` loop and import nothing.
//
// A signal says THAT something moved and where the log tip is; it never says what changed (that is
// viewer-specific: `describeChange`) and it carries no content. It is at-least-once: a listener may
// be told about the same `sequence` twice and must treat `sequence` as the idempotency key.

export interface HeadChange {
  readonly experienceId: string;
  /** The log tip. Monotone per line; the idempotency key of a notification. */
  readonly sequence: number;
  /** The latest version (the head), or null when the line has none yet. */
  readonly head: string | null;
  /** The version the app chose to show, or null. */
  readonly promoted: string | null;
}

export interface HeadSignal {
  /**
   * Call `onChange` whenever `experienceId`'s log moves past what this watcher last saw, until the
   * returned function is called. The first notification is for the CURRENT state iff the line is
   * non-empty (a watcher that starts late still learns the head). `onChange` throwing never stops
   * the signal.
   */
  watch(experienceId: string, onChange: (change: HeadChange) => void): () => void;
}
