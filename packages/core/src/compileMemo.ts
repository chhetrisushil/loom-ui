import type { CompileOptions, CompileResult } from "./compile";
import type { Experience } from "./experience";

// ── A per-version compile memo ─────────────────────────────────────────────────────────────────
// `compile` is a pure function of (the experience, its options). A host compiles the same sealed
// version again and again (one per viewer render, per surface, per reconnect), so the result is
// remembered — but only when the key provably covers every input `compile` reads:
//
//   exp.*              the sealed `versionHash` (content address) AND, as a guard against a spread
//                      that kept a stale hash, the identity of every field compile reads: root,
//                      providers, intent, the three class maps, vocabularyFloor, experienceId.
//                      An UNSEALED experience (`versionHash === ""`) is never memoized.
//   surface, hydrationProjectionId/Version, undeclared, requirePlaceholderKey   by value
//   viewer             `undefined` vs its `clearance` (the only field `mayView` reads)
//   title, restrictedLabel   by value (JSON)
//   placeholderKey     the key BYTES (hex); an unusable key is not memoized (compile throws)
//   projections, declaredToolClasses   by CONTENT (a host raising a declaration in a rebuilt table
//                      must move the key, whatever the table's identity)
//   catalog, baseCatalog   by IDENTITY (readonly zod-bearing objects: treat as immutable, build a
//                      new one to change one)
//   resolveLabel       a custom resolver is opaque (its output may follow a locale): memoized only
//                      when the caller names its output in `resolveLabelKey` (scoped to THAT resolver's
//                      identity, so two hosts with one key string never cross-serve); the default
//                      (fallback text) needs none
//   registry           NEVER memoized (a registry can gain renderers after the fact)
//
// Results are never shared: a structured clone goes in, and a clone comes out on every hit
// (measured, 500 nodes: compile 2.6 ms, structuredClone of the result 1.3 ms; so a hit is ~2x
// cheaper than a compile, not free). A result `structuredClone` cannot copy is served UNCACHED.
//
// HITS REQUIRE HOLDING THE OBJECT. The content check is by reference, because the only cheaper
// content check would be recomputing the version hash, and that costs ~9x a compile (24 ms, it
// re-parses and canonicalises, and `mintVersionHash` lives in the Node-only `./log`). A host that
// re-reads the experience each render gets a fresh object: that is a miss (a plain compile), and
// it does not evict the entry held for the first object. Keep one sealed object per version.
//
// IMMUTABILITY: the catalogs (identity-keyed) and the experience's root / providers / maps
// (reference-compared) must be treated as immutable. Mutating one in place is invisible to the
// memo; build a new object to change one.

export interface CompileMemoOptions {
  /** Most entries kept (least recently used evicted first). Default {@link DEFAULT_COMPILE_MEMO_MAX}. */
  readonly max?: number;
}

export const DEFAULT_COMPILE_MEMO_MAX = 32;

interface Entry {
  readonly exp: Experience;
  readonly result: CompileResult;
}

const SAME_FIELDS = [
  "experienceId",
  "intent",
  "root",
  "providers",
  "handleClasses",
  "toolClasses",
  "projectionClasses",
  "vocabularyFloor",
] as const;

const sameContent = (a: Experience, b: Experience): boolean =>
  a === b || SAME_FIELDS.every((k) => a[k] === b[k]);

export class CompileMemo {
  readonly max: number;
  private readonly entries = new Map<string, Entry>();
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;
  /** Counters for tests and host metrics. */
  hits = 0;
  misses = 0;

  constructor(opts: CompileMemoOptions = {}) {
    const m = opts.max ?? DEFAULT_COMPILE_MEMO_MAX;
    this.max = Number.isInteger(m) && m >= 1 ? m : DEFAULT_COMPILE_MEMO_MAX;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private idOf(o: object): number {
    let id = this.ids.get(o);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(o, id);
    }
    return id;
  }

  /** The key, or undefined when this call must not be memoized. */
  keyOf(exp: Experience, opts: CompileOptions): string | undefined {
    if (exp.versionHash === "" || typeof exp.versionHash !== "string") return undefined;
    if (opts.registry !== undefined) return undefined;
    if (opts.resolveLabel !== undefined && opts.resolveLabelKey === undefined) return undefined;
    let placeholderKey: string | null = null;
    if (opts.placeholderKey !== undefined) {
      const bytes =
        typeof opts.placeholderKey === "string"
          ? new TextEncoder().encode(opts.placeholderKey)
          : opts.placeholderKey instanceof Uint8Array
            ? opts.placeholderKey
            : undefined;
      if (bytes === undefined) return undefined;
      placeholderKey = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    try {
      return JSON.stringify([
        exp.versionHash,
        opts.surface,
        this.idOf(opts.catalog),
        opts.baseCatalog === undefined ? null : this.idOf(opts.baseCatalog),
        opts.hydrationProjectionId,
        opts.hydrationProjectionVersion,
        opts.projections ?? null,
        sortedRecord(opts.declaredToolClasses),
        opts.undeclared ?? null,
        opts.resolveLabel === undefined
          ? null
          : [this.idOf(opts.resolveLabel), opts.resolveLabelKey ?? null],
        opts.title ?? null,
        opts.restrictedLabel ?? null,
        opts.viewer === undefined ? null : [opts.viewer.clearance ?? null],
        placeholderKey,
        opts.requirePlaceholderKey === true,
      ]);
    } catch {
      return undefined; // unserializable option (a cycle, a BigInt): never guess
    }
  }

  /** A fresh copy of the remembered result for this call, or undefined on a miss. */
  get(key: string, exp: Experience): CompileResult | undefined {
    const e = this.entries.get(key);
    if (e === undefined || !sameContent(e.exp, exp)) {
      this.misses++;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, e); // most recently used
    try {
      const copy = structuredClone(e.result);
      this.hits++;
      return copy;
    } catch {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
  }

  /** Remember a clone of `result` (the caller keeps the original). Evicts the LRU entry past `max`. */
  set(key: string, exp: Experience, result: CompileResult): void {
    // The slot already belongs to ANOTHER object with this version hash (a reloaded copy, or a
    // spread that kept a stale hash): do not evict the holder for it (that is clone churn for an
    // alternating pair, and a stale-hash object must never displace the genuine one).
    const held = this.entries.get(key);
    if (held !== undefined && !sameContent(held.exp, exp)) return;
    let kept: CompileResult;
    try {
      kept = structuredClone(result);
    } catch {
      return; // not plain data: serve it uncached rather than share it
    }
    this.entries.delete(key);
    this.entries.set(key, { exp, result: kept });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function sortedRecord(r: Readonly<Record<string, string>> | undefined): unknown {
  if (r === undefined) return null;
  return Object.keys(r)
    .sort()
    .map((k) => [k, r[k]]);
}

/** The process-wide memo `compile` uses unless told otherwise. */
export const defaultCompileMemo = new CompileMemo();

export function createCompileMemo(opts?: CompileMemoOptions): CompileMemo {
  return new CompileMemo(opts);
}
