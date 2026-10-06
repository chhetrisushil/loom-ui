import { MAX_DRAFT_NODES } from "./contract";

/**
 * An incremental, bounded scanner over a model reply of the shape `{ "summary": …, "nodes": [ … ] }`
 * that yields each element of `nodes` the moment its closing brace arrives — the partial-JSON half
 * of streaming. It is a single forward pass (linear in total chars: each chunk is scanned once with carried state, and only the CURRENT element's text is kept), never throws,
 * and is BEST-EFFORT by design: what it yields is a candidate for a live partial; the AUTHORITATIVE
 * parse is always `parseModelJson` over the whole assembled reply. A node it skips (not valid
 * JSON) or stops yielding (a bound) is therefore never lost, only shown late — with the rest, at
 * the end.
 *
 * Bounded three ways (a hostile or runaway stream cannot make the scanner do unbounded work or
 * hold unbounded memory): `maxChars` of total input, `maxNodeChars` per node, `maxNodes` yielded.
 * Hitting a bound sets `stopped`; the caller keeps collecting the reply but gets no more partials.
 *
 * Preamble before the first `{` (a code fence, a sentence) and everything after the object closes
 * are ignored, the same tolerance `parseModelJson` has for a fence.
 */
export interface ScanLimits {
  readonly maxChars?: number;
  readonly maxNodeChars?: number;
  readonly maxNodes?: number;
}

export const DEFAULT_SCAN_LIMITS = {
  maxChars: 256 * 1024,
  maxNodeChars: 16 * 1024,
  /** The reply cap: containers stream as flat entries (children name their `parent`), so nesting costs the scanner nothing. */
  maxNodes: MAX_DRAFT_NODES,
} as const;

export class NodeScanner {
  private readonly maxChars: number;
  private readonly maxNodeChars: number;
  private readonly maxNodes: number;
  private total = 0; // chars fed so far
  private depth = 0;
  private inStr = false;
  private esc = false;
  private expectKey = false; // at depth 1: the next string is a key
  private keyParts: string[] = []; // the depth-1 key being read (bounded)
  private keyLen = 0;
  private key1 = ""; // the last key seen at depth 1
  private inNodes = false; // the depth-2 array under key "nodes"
  private inElem = false;
  private elemParts: string[] = []; // flushed pieces of the current element
  private elemLen = 0; // chars in elemParts
  private yielded = 0;
  private done = false;
  /** A bound was hit (or the object closed): no further nodes will be yielded. */
  stopped = false;

  constructor(limits: ScanLimits = {}) {
    this.maxChars = limits.maxChars ?? DEFAULT_SCAN_LIMITS.maxChars;
    this.maxNodeChars = limits.maxNodeChars ?? DEFAULT_SCAN_LIMITS.maxNodeChars;
    this.maxNodes = limits.maxNodes ?? DEFAULT_SCAN_LIMITS.maxNodes;
  }

  /** Forget everything: a retried attempt starts from nothing. */
  reset(): void {
    this.total = 0;
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
    this.expectKey = false;
    this.keyParts = [];
    this.keyLen = 0;
    this.key1 = "";
    this.inNodes = false;
    this.inElem = false;
    this.elemParts = [];
    this.elemLen = 0;
    this.yielded = 0;
    this.done = false;
    this.stopped = false;
  }

  /** Feed the next chunk; returns the nodes that CLOSED within it, parsed, in order. */
  feed(chunk: string): unknown[] {
    const out: unknown[] = [];
    if (this.stopped || this.done) return out;
    if (this.total + chunk.length > this.maxChars) {
      this.stopped = true;
      return out;
    }
    this.total += chunk.length;
    // Start (in THIS chunk) of the unflushed part of the current element / key; -1 = none.
    let elemFrom = this.inElem ? 0 : -1;
    let keyFrom = this.inStr && this.depth === 1 && this.expectKey ? 0 : -1;
    const flushElem = (to: number) => {
      if (elemFrom < 0) return;
      const piece = chunk.slice(elemFrom, to);
      this.elemParts.push(piece);
      this.elemLen += piece.length;
    };
    const flushKey = (to: number) => {
      if (keyFrom < 0 || this.keyLen > KEY_MAX) return;
      const piece = chunk.slice(keyFrom, to);
      this.keyParts.push(piece);
      this.keyLen += piece.length;
    };
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === 92 /* \\ */) this.esc = true;
        else if (c === 34 /* " */) {
          this.inStr = false;
          if (keyFrom >= 0) {
            flushKey(i);
            keyFrom = -1;
            this.expectKey = false;
            this.key1 = this.keyLen > KEY_MAX ? "" : this.keyText(this.keyParts.join(""));
          }
        }
        continue;
      }
      if (this.inElem && this.depth >= 3 && this.elemLen + (i - elemFrom) > this.maxNodeChars) {
        this.stopped = true;
        return out;
      }
      if (c === 34) {
        this.inStr = true;
        if (this.depth === 1 && this.expectKey) {
          keyFrom = i + 1;
          this.keyParts = [];
          this.keyLen = 0;
        }
      } else if (c === 123 /* { */ || c === 91 /* [ */) {
        if (this.depth === 0) {
          if (c !== 123) continue; // preamble: ignore until the object opens
          this.expectKey = true;
        } else if (this.depth === 1 && c === 91 && this.key1 === "nodes") this.inNodes = true;
        else if (this.depth === 2 && this.inNodes && c === 123) {
          this.inElem = true;
          elemFrom = i;
          this.elemParts = [];
          this.elemLen = 0;
        }
        this.depth++;
      } else if (c === 125 /* } */ || c === 93 /* ] */) {
        if (this.depth === 0) continue;
        this.depth--;
        if (this.depth === 2 && this.inNodes && c === 125 && this.inElem) {
          flushElem(i + 1);
          const text = this.elemParts.join("");
          this.inElem = false;
          elemFrom = -1;
          this.elemParts = [];
          this.elemLen = 0;
          try {
            out.push(JSON.parse(text));
          } catch {
            // best-effort: the authoritative parse of the whole reply will name the defect
          }
          this.yielded++;
          if (this.yielded >= this.maxNodes) {
            this.stopped = true;
            return out;
          }
        } else if (this.depth === 1 && this.inNodes) {
          // `nodes` closed: nothing after it can add a node (a repeated "nodes" key must not
          // reopen it — the authoritative parse sees only one).
          this.inNodes = false;
          this.done = true;
          return out;
        } else if (this.depth === 0) {
          this.done = true;
          return out;
        }
      } else if (c === 44 /* , */ && this.depth === 1) this.expectKey = true;
    }
    // Carry the unflushed tails of an open element / key into the next chunk.
    flushElem(chunk.length);
    flushKey(chunk.length);
    return out;
  }

  private keyText(raw: string): string {
    if (!raw.includes("\\")) return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return "";
    }
  }
}

/** Longest depth-1 key the scanner will read; a longer one is "not `nodes`" without being kept. */
const KEY_MAX = 256;
