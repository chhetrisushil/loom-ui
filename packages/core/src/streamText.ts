// ── The token-append contract for a streamed text value (`StreamingText`) ──────────────────────
// Dependency-free (it ships on the browser entry and the hydration client): a stream is an
// ordered, gap-free sequence of chunks numbered from 0, closed by one `done`. Appending is a pure
// fold, so a store, a test and a renderer agree on what a stream means:
//
//   - IDEMPOTENT: a chunk whose `seq` was already applied is ignored (a retried delivery cannot
//     double a token), reported as `applied: false`, never as an error.
//   - ORDERED, NOT BUFFERED: a gap (`seq` past the next one) is refused (`stream-gap`) rather than
//     held — the producer owns ordering; a store that buffered would be unbounded memory.
//   - CLOSED: after `done`, new chunks are refused (`stream-closed`); redelivery is a no-op.
//   - BOUNDED: one chunk is at most MAX_CHUNK_TEXT UTF-16 units, the whole text at most
//     MAX_STREAM_TEXT. An over-bound chunk is refused with the state unchanged, so the producer can
//     still close the stream with an empty `done` chunk.
//
// The value a widget sees is just the accumulated string — the kind's value contract is unchanged;
// the sequencing lives here, on the way in.

import type { Finding } from "./experience";

export const MAX_CHUNK_TEXT = 8 * 1024;
export const MAX_STREAM_TEXT = 64 * 1024;

export interface TextChunk {
  /** 0-based, consecutive. */
  readonly seq: number;
  readonly text: string;
  /** The last chunk of the stream. */
  readonly done?: boolean;
}
export interface StreamedText {
  readonly text: string;
  /** The `seq` the next chunk must carry. */
  readonly nextSeq: number;
  readonly done: boolean;
}
export type AppendResult =
  | { readonly ok: true; readonly state: StreamedText; readonly applied: boolean }
  | { readonly ok: false; readonly finding: Finding };

const refuse = (code: string, message: string): AppendResult => ({
  ok: false,
  finding: { code, severity: "error", message },
});

/** Fold one chunk into the stream's state. Total: never throws, whatever `chunk` is. */
export function appendChunk(state: StreamedText | undefined, chunk: unknown): AppendResult {
  if (typeof chunk !== "object" || chunk === null)
    return refuse("stream-chunk-invalid", "a stream chunk is an object { seq, text, done? }");
  const { seq, text, done } = chunk as { seq?: unknown; text?: unknown; done?: unknown };
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
    return refuse("stream-chunk-invalid", "chunk.seq must be a non-negative integer");
  if (typeof text !== "string")
    return refuse("stream-chunk-invalid", "chunk.text must be a string");
  if (done !== undefined && typeof done !== "boolean")
    return refuse("stream-chunk-invalid", "chunk.done must be a boolean when present");
  if (text.length > MAX_CHUNK_TEXT)
    return refuse(
      "stream-chunk-invalid",
      `chunk.text is ${text.length} units, over the ${MAX_CHUNK_TEXT} limit`
    );
  const cur = state ?? { text: "", nextSeq: 0, done: false };
  if (seq < cur.nextSeq) return { ok: true, state: cur, applied: false };
  if (cur.done) return refuse("stream-closed", `the stream is closed (done); chunk ${seq} refused`);
  if (seq !== cur.nextSeq)
    return refuse(
      "stream-gap",
      `expected chunk ${cur.nextSeq}, got ${seq}; a stream is gap-free and starts at 0`
    );
  if (cur.text.length + text.length > MAX_STREAM_TEXT)
    return refuse(
      "stream-too-large",
      `the stream would exceed ${MAX_STREAM_TEXT} units; close it with an empty done chunk`
    );
  return {
    ok: true,
    applied: true,
    state: { text: cur.text + text, nextSeq: cur.nextSeq + 1, done: done === true },
  };
}
