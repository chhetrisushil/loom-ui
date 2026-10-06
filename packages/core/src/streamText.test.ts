import { describe, expect, it } from "vitest";
import { MAX_CHUNK_TEXT, MAX_STREAM_TEXT, appendChunk } from "./streamText";

const ok = (r: ReturnType<typeof appendChunk>) => {
  if (!r.ok) throw new Error(r.finding.message);
  return r;
};

describe("appendChunk — the token-append contract for StreamingText", () => {
  it("starts at seq 0 and accumulates in order", () => {
    let s = ok(appendChunk(undefined, { seq: 0, text: "Hel" })).state;
    s = ok(appendChunk(s, { seq: 1, text: "lo" })).state;
    expect(s).toEqual({ text: "Hello", nextSeq: 2, done: false });
  });

  it("is idempotent: a redelivered seq is ignored, not appended twice", () => {
    const a = ok(appendChunk(undefined, { seq: 0, text: "Hi" }));
    const b = ok(appendChunk(a.state, { seq: 0, text: "Hi" }));
    expect(b.applied).toBe(false);
    expect(b.state).toEqual(a.state);
  });

  it("refuses a stream that does not begin at 0 and a gap (no reordering buffer)", () => {
    const first = appendChunk(undefined, { seq: 3, text: "x" });
    expect(first.ok).toBe(false);
    const s = ok(appendChunk(undefined, { seq: 0, text: "a" })).state;
    const gap = appendChunk(s, { seq: 2, text: "c" });
    expect(!gap.ok && gap.finding.code).toBe("stream-gap");
  });

  it("closes on done; later new chunks are refused, redelivery of done is a no-op", () => {
    const s = ok(appendChunk(undefined, { seq: 0, text: "Hi", done: true })).state;
    expect(s.done).toBe(true);
    const more = appendChunk(s, { seq: 1, text: "!" });
    expect(!more.ok && more.finding.code).toBe("stream-closed");
    const dup = ok(appendChunk(s, { seq: 0, text: "Hi", done: true }));
    expect(dup.applied).toBe(false);
  });

  it("bounds a chunk and the whole text; the refusal leaves the state untouched", () => {
    const big = appendChunk(undefined, { seq: 0, text: "x".repeat(MAX_CHUNK_TEXT + 1) });
    expect(!big.ok && big.finding.code).toBe("stream-chunk-invalid");
    let s = ok(appendChunk(undefined, { seq: 0, text: "x".repeat(MAX_CHUNK_TEXT) })).state;
    for (let i = 1; s.text.length + MAX_CHUNK_TEXT <= MAX_STREAM_TEXT; i++)
      s = ok(appendChunk(s, { seq: i, text: "x".repeat(MAX_CHUNK_TEXT) })).state;
    const over = appendChunk(s, { seq: s.nextSeq, text: "x".repeat(MAX_CHUNK_TEXT) });
    expect(!over.ok && over.finding.code).toBe("stream-too-large");
    // the producer can still close it
    expect(appendChunk(s, { seq: s.nextSeq, text: "", done: true }).ok).toBe(true);
  });

  it("rejects malformed chunks without throwing", () => {
    for (const bad of [
      null,
      1,
      {},
      { seq: -1, text: "" },
      { seq: 1.5, text: "" },
      { seq: 0, text: 3 },
      { seq: 0, text: "", done: "y" },
    ])
      expect(appendChunk(undefined, bad).ok).toBe(false);
  });
});
