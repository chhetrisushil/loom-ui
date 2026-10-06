/**
 * An incremental, bounded scanner over a model reply of the shape `{ "summary": …, "nodes": [ … ] }`
 * that yields each element of `nodes` the moment its closing brace arrives — the partial-JSON half
 * of streaming. It is a single forward pass (O(total chars), no re-scan per chunk), never throws,
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
  maxNodes: 24,
} as const;

export class NodeScanner {
  private readonly maxChars: number;
  private readonly maxNodeChars: number;
  private readonly maxNodes: number;
  private buf = "";
  private pos = 0; // next index to scan
  private depth = 0;
  private inStr = false;
  private esc = false;
  private strStart = 0;
  private expectKey = false; // at depth 1: the next string is a key
  private key1 = ""; // the last key seen at depth 1
  private inNodes = false; // the depth-2 array under key "nodes"
  private elemStart = -1;
  private yielded = 0;
  private done = false;
  /** A bound was hit (or the object closed): no further nodes will be yielded. */
  stopped = false;

  constructor(limits: ScanLimits = {}) {
    this.maxChars = limits.maxChars ?? DEFAULT_SCAN_LIMITS.maxChars;
    this.maxNodeChars = limits.maxNodeChars ?? DEFAULT_SCAN_LIMITS.maxNodeChars;
    this.maxNodes = limits.maxNodes ?? DEFAULT_SCAN_LIMITS.maxNodes;
  }

  /** Feed the next chunk; returns the nodes that CLOSED within it, parsed, in order. */
  feed(chunk: string): unknown[] {
    const out: unknown[] = [];
    if (this.stopped || this.done) return out;
    if (this.buf.length + chunk.length > this.maxChars) {
      this.stopped = true;
      return out;
    }
    this.buf += chunk;
    const b = this.buf;
    for (; this.pos < b.length; this.pos++) {
      const i = this.pos;
      const c = b.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === 92 /* \ */) this.esc = true;
        else if (c === 34 /* " */) {
          this.inStr = false;
          if (this.depth === 1 && this.expectKey) {
            this.expectKey = false;
            this.key1 = this.keyText(b.slice(this.strStart + 1, i));
          }
        }
        continue;
      }
      if (this.depth >= 3 && this.elemStart >= 0 && i - this.elemStart > this.maxNodeChars) {
        this.stopped = true;
        return out;
      }
      if (c === 34) {
        this.inStr = true;
        this.strStart = i;
      } else if (c === 123 /* { */ || c === 91 /* [ */) {
        if (this.depth === 0) {
          if (c !== 123) continue; // preamble: ignore until the object opens
          this.expectKey = true;
        } else if (this.depth === 1 && c === 91 && this.key1 === "nodes") this.inNodes = true;
        else if (this.depth === 2 && this.inNodes && c === 123) this.elemStart = i;
        this.depth++;
      } else if (c === 125 /* } */ || c === 93 /* ] */) {
        if (this.depth === 0) continue;
        this.depth--;
        if (this.depth === 2 && this.inNodes && c === 125 && this.elemStart >= 0) {
          const text = b.slice(this.elemStart, i + 1);
          this.elemStart = -1;
          try {
            out.push(JSON.parse(text));
          } catch {
            // best-effort: the authoritative parse of the whole reply will name the defect
          }
          this.yielded++;
          if (this.yielded >= this.maxNodes) {
            this.stopped = true;
            this.pos = i + 1;
            return out;
          }
        } else if (this.depth === 1 && this.inNodes) this.inNodes = false;
        else if (this.depth === 0) {
          this.done = true;
          this.pos = i + 1;
          return out;
        }
      } else if (c === 44 /* , */ && this.depth === 1) this.expectKey = true;
    }
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
