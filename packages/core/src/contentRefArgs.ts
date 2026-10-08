// ── Media: content-reference TOOL ARGUMENTS (U9b) ──────────────────────────────
//
// U9 keeps an address out of every node prop. The remaining door is a capability's `arguments`: a
// tool that takes a content reference as INPUT (`describe_image({ image: "sha256:…" })`) would
// otherwise let the composing model name any address it has seen or guessed, and the host's invoker
// would run it as the viewer. This module closes that door at composition (`validateExperience`),
// and the same predicate re-checks at run time (hydration), so a model can never AUTHOR one.
//
// THE ARGUMENT GRAMMAR. A step's `arguments` is JSON. A value in it is exactly one of:
//   1. a literal (any JSON value): written by whoever composed the step;
//   2. a relative-time token, a string `$now`, `$now-7d`, `$now+1h` (units s m h d w): resolved at
//      load against one instant; meaningful for time arguments only;
//   3. a step reference, a WHOLE string `{{steps.<id>.output[.<path>]}}`: replaced by another step's
//      hydrated output. `<id>` must name a step of the same provider graph that runs in an EARLIER
//      wave; a template embedded in a longer string is NOT substituted (it is a literal);
//   4. a PARAM: a top-level key the step lists in `overridable` may be replaced, per load, by the
//      host's `setParams` / `defaultParams` (or a split client's params) value.
// A content-reference position (the {@link CONTENT_REF_KEYWORD} marker below) may legitimately hold
// ONLY (3) a step reference whose REFERENCED output is itself declared to be a content reference (the
// producing tool's OUTPUT schema carries the same marker at that path: an echo or concat tool that
// merely passes text through proves nothing and is `media-arg-unproven-ref`), or (4) a param the HOST
// accepted (`acceptContentRefParam`: the value came out of `acceptMediaAttach` for THIS principal), or
// nothing (absent, or JSON null; null is stripped before the call). Anything else at a marked position
// is a LITERAL, and is refused: a literal address, a time token, a number, an object. The argument
// hook is the host's own code and runs after the check; it may set whatever it likes. What this does
// NOT prove: that a declared producer's output is trustworthy (an untrusted tool can still return a
// hostile address; the host's invoker authorises the call).
//
// Zod-free and DOM-free. Every message is value-free (an address never appears in a finding).

import type { Finding } from "./experience";
import { MAX_EMBEDDED_SCAN, containsEmbeddedRef, looksLikeLiteralRef } from "./media";

/**
 * The marker a capability's input JSON Schema carries on a field that holds a content reference:
 * `{ "type": "string", "x-content-ref": true }`, at any nesting depth (object properties, array
 * items, `allOf`/`anyOf`/`oneOf` branches, local `$ref`s). Chosen over `format: "content-ref"`
 * because (a) an `x-` keyword is the JSON Schema extension point and annotates ANY value (an object
 * shaped like a `MediaRef`, not only a string), (b) it names the concept, not a consumer or a
 * store, and (c) `format` is an assertion vocabulary that some validators reject when unknown.
 * The marker's value must be exactly `true` (`false` is ignored; any other value makes the whole
 * schema {@link ContentRefPaths} `unknown`).
 */
export const CONTENT_REF_KEYWORD = "x-content-ref";

/** A path into `arguments`: a string is an object key; `null` is ANY array index or object key. */
export type ArgPath = readonly (string | null)[];

export type ContentRefPaths =
  | { readonly status: "ok"; readonly paths: readonly ArgPath[] }
  | {
      readonly status: "unknown";
      readonly reason: string;
      /** The schema (or an unreadable part of it) mentions the marker: the strict case. */
      readonly markerMentioned: boolean;
    };

/**
 * One tool's marked INPUT paths. `"unknown"`: the schema mentions the marker but cannot be fully
 * read: strict (composition refuses the binding; run time refuses every literal string and gates every
 * param). `"unreadable"`: unreadable and no marker is mentioned: a warning, plus any wholly
 * address-shaped string is refused.
 */
export type ContentRefEntry = readonly ArgPath[] | "unknown" | "unreadable";

/**
 * What a host derives from its capabilities (planner `contentRefArgsFrom`) and hands to BOTH
 * composition and hydration. Plain JSON: persist it with the capability set and re-read it with
 * {@link parseContentRefTable}.
 */
export interface ContentRefTable {
  /** Marked input paths per tool (`toolKey`). */
  readonly args: Readonly<Record<string, ContentRefEntry>>;
  /**
   * Marked OUTPUT paths per tool: where a tool declares that its output is a content reference
   * (`[]` = the whole output). Only a step reference to such a path may stand at a marked argument.
   */
  readonly produces?: Readonly<Record<string, readonly ArgPath[]>>;
}

/** An empty table: nothing marked, nothing produced. */
export const EMPTY_CONTENT_REF_TABLE: ContentRefTable = Object.freeze({ args: Object.freeze({}) });

export const MAX_SCHEMA_NODES = 5000;
export const MAX_SCHEMA_PATH_DEPTH = 24;
export const MAX_CONTENT_REF_PATHS = 256;
/** Deepest `arguments` nesting {@link contentRefArgFindings} walks; deeper is refused. */
export const MAX_ARG_DEPTH = 64;
/** Most JSON values {@link contentRefArgFindings} visits in one step's arguments; more is refused. */
export const MAX_ARG_VALUES = 100_000;
const MAX_SUSPECT_SCAN_CHARS = 262_144;
const MAX_SUSPECT_FINDINGS = 8;
/** Most `media-arg-literal` findings reported per step; the rest are counted ("and N more"). */
export const MAX_LITERAL_FINDINGS = 8;

class Unreadable extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `#` or `#/a/b` (JSON Pointer, `~0` `~1` unescaped, `%`-decoded); `undefined` for anything else. */
function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(cur)) {
      if (!/^(?:0|[1-9]\d{0,8})$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (isObj(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Unique objects in `v` carrying `x-content-ref: true` (a bounded pass; over budget => Infinity, which
 * reads as "unreachable markers" and so fails closed), and whether the keyword is mentioned at all.
 */
function rawMarkers(v: unknown): { count: number; mentioned: boolean } {
  const seen = new Set<object>();
  let count = 0;
  let mentioned = false;
  const stack: unknown[] = [v];
  for (let n = 0; stack.length > 0; ) {
    if (++n > MAX_SCHEMA_NODES) return { count: Number.POSITIVE_INFINITY, mentioned: true };
    const cur = stack.pop();
    if (typeof cur !== "object" || cur === null || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) for (const x of cur) stack.push(x);
    else {
      if (Object.hasOwn(cur, CONTENT_REF_KEYWORD)) {
        mentioned = true;
        if ((cur as Record<string, unknown>)[CONTENT_REF_KEYWORD] === true) count++;
      }
      for (const x of Object.values(cur)) stack.push(x);
    }
  }
  return { count, mentioned };
}

/**
 * The content-reference paths a capability's input JSON Schema marks with {@link CONTENT_REF_KEYWORD}.
 * Total: never throws. A bounded walk (`MAX_SCHEMA_NODES` schemas, `MAX_SCHEMA_PATH_DEPTH` levels,
 * `MAX_CONTENT_REF_PATHS` paths); only local `$ref`s resolve; a `$ref` cycle is cut, and is
 * `unknown` only if the schema mentions the marker at all (a recursive schema with no marker has
 * none to miss). `unknown` = the schema is not something this can read (not an object, an external
 * or dangling `$ref`, a malformed marker, a walk budget exceeded): callers must NOT read it as "no
 * marked arguments". A schema with no marker is `{ status: "ok", paths: [] }`.
 */
export function contentRefPaths(
  schema: unknown,
  opts: { readonly allowRoot?: boolean } = {}
): ContentRefPaths {
  if (schema === undefined) return { status: "ok", paths: [] };
  if (!isObj(schema) && typeof schema !== "boolean")
    return {
      status: "unknown",
      reason: "the input schema is not a JSON Schema object",
      markerMentioned: false,
    };
  const raw = rawMarkers(schema);
  const reached = new Set<object>();
  let opaque = false;
  const found = new Map<string, ArgPath>();
  let nodes = 0;
  let cyclic = false;
  const visit = (s: unknown, path: ArgPath, stack: readonly string[]): void => {
    if (typeof s === "boolean") return;
    if (!isObj(s)) throw new Unreadable("a sub-schema is not a JSON Schema object");
    if (++nodes > MAX_SCHEMA_NODES) throw new Unreadable("the input schema is too large to read");
    if (path.length > MAX_SCHEMA_PATH_DEPTH)
      throw new Unreadable("the input schema nests too deeply to read");
    if (Object.hasOwn(s, CONTENT_REF_KEYWORD)) {
      const m = s[CONTENT_REF_KEYWORD];
      if (m === true) {
        if (path.length === 0 && opts.allowRoot !== true)
          throw new Unreadable("the marker is on the arguments object itself");
        reached.add(s);
        if (found.size >= MAX_CONTENT_REF_PATHS && !found.has(JSON.stringify(path)))
          throw new Unreadable("the input schema marks too many content references");
        found.set(JSON.stringify(path), path);
        return;
      }
      if (m !== false) throw new Unreadable(`"${CONTENT_REF_KEYWORD}" must be true or false`);
    }
    for (const k of ["$dynamicRef", "$recursiveRef", "$dynamicAnchor", "$recursiveAnchor"] as const)
      if (Object.hasOwn(s, k)) opaque = true;
    if (Object.hasOwn(s, "$ref")) {
      const ref = s.$ref;
      if (typeof ref !== "string") throw new Unreadable("a $ref is not a string");
      if (stack.includes(ref)) cyclic = true;
      else {
        const target = resolveLocalRef(schema, ref);
        if (target === undefined) throw new Unreadable("a $ref does not resolve inside the schema");
        visit(target, path, [...stack, ref]);
      }
    }
    if (isObj(s.properties))
      for (const k of Object.keys(s.properties)) visit(s.properties[k], [...path, k], stack);
    if (isObj(s.patternProperties))
      for (const v of Object.values(s.patternProperties)) visit(v, [...path, null], stack);
    for (const key of [
      "additionalProperties",
      "unevaluatedProperties",
      "unevaluatedItems",
    ] as const)
      if (Object.hasOwn(s, key)) visit(s[key], [...path, null], stack);
    for (const key of ["items", "additionalItems", "contains"] as const) {
      if (!Object.hasOwn(s, key)) continue;
      const v = s[key];
      if (Array.isArray(v)) for (const x of v) visit(x, [...path, null], stack);
      else visit(v, [...path, null], stack);
    }
    if (Array.isArray(s.prefixItems))
      for (const x of s.prefixItems) visit(x, [...path, null], stack);
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const v = s[key];
      if (Array.isArray(v)) for (const x of v) visit(x, path, stack);
    }
    for (const key of ["not", "if", "then", "else"] as const)
      if (Object.hasOwn(s, key)) visit(s[key], path, stack);
    for (const key of ["dependentSchemas", "dependencies"] as const) {
      const dep = s[key];
      if (!isObj(dep)) continue;
      // Draft-07 `dependencies` maps to a schema OR a list of property names (no schema there).
      for (const v of Object.values(dep)) if (!Array.isArray(v)) visit(v, path, stack);
    }
  };
  try {
    visit(schema, [], []);
  } catch (e) {
    return {
      status: "unknown",
      reason: e instanceof Unreadable ? e.message : "the input schema could not be read",
      markerMentioned: raw.mentioned,
    };
  }
  const unknown = (reason: string): ContentRefPaths => ({
    status: "unknown",
    reason,
    markerMentioned: true,
  });
  if (cyclic && raw.mentioned) return unknown("the schema is recursive and carries the marker");
  if (opaque && raw.mentioned)
    return unknown("the schema uses a dynamic reference keyword and carries the marker");
  // BACKSTOP: a marker the walk never reached (under propertyNames, contentSchema, an unreferenced
  // definition, a keyword this walker does not know) is a reference the guard would not see.
  if (raw.count > reached.size) return unknown("the schema carries a marker the walk cannot reach");
  return { status: "ok", paths: [...found.values()] };
}

/** `arguments."a"[]."c"` — keys are tool-server text, so a key is shown only as a JSON string literal. */
export function formatArgPath(path: ArgPath, root = "arguments"): string {
  return `${root}${path.map((s) => (s === null ? "[]" : `.${JSON.stringify(s)}`)).join("")}`;
}

// ── Reading arguments ────────────────────────────────────────────────────────────

/** `{{steps.<id>.output[.<path>]}}` as a WHOLE string: the only step-reference form. Mirrors hydration's `STEP_TEMPLATE` (a hydration test pins them equal). The id is `[A-Za-z0-9_-]+`. */
export const STEP_TEMPLATE_SOURCE = "^\\{\\{steps\\.([A-Za-z0-9_-]+)\\.output(?:\\.(.+))?\\}\\}$";
const STEP_TEMPLATE = new RegExp(STEP_TEMPLATE_SOURCE);
const TIME_TOKEN_LIKE = /^\$now(?![A-Za-z0-9_])/;
const TIME_TOKEN = /^\$now(?:[+-]\d{1,9}[smhdw])?$/;
const PATH_SEGMENT = /^([^[\]]+)((?:\[\d+\])*)$/;

/** A parsed step reference: the step id and the path into its output (`null` = an array index). */
export interface StepReference {
  readonly stepId: string;
  /** `undefined` = the path is malformed (it resolves to nothing; never proven). */
  readonly path: ArgPath | undefined;
}

/** Parse a whole-string step reference; `undefined` when the string is not one. */
export function parseStepReference(v: unknown): StepReference | undefined {
  if (typeof v !== "string") return undefined;
  const m = STEP_TEMPLATE.exec(v);
  if (m === null) return undefined;
  const stepId = m[1] as string;
  const dotted = m[2];
  if (dotted === undefined) return { stepId, path: [] };
  const path: (string | null)[] = [];
  for (const part of dotted.split(".")) {
    const seg = PATH_SEGMENT.exec(part);
    if (seg === null) return { stepId, path: undefined };
    path.push(seg[1] as string);
    for (const _ of (seg[2] ?? "").match(/\[\d+\]/g) ?? []) path.push(null);
  }
  return { stepId, path };
}

/** Does a marked OUTPUT path cover a referenced output path? A `null` marked segment covers any key or index. */
export function pathCovers(marked: ArgPath, ref: ArgPath): boolean {
  if (marked.length !== ref.length) return false;
  for (let i = 0; i < marked.length; i++) {
    const m = marked[i];
    if (m !== null && m !== ref[i]) return false;
  }
  return true;
}

/** May a value stand at a content-reference position without a proof? Only nothing: absent or null. */
export const isLegitimateContentRef = (v: unknown): boolean => v === undefined || v === null;

interface Trie {
  mark: boolean;
  readonly keys: Map<string, Trie>;
  any?: Trie;
}
const newTrie = (): Trie => ({ mark: false, keys: new Map() });

function buildTrie(paths: readonly ArgPath[]): Trie {
  const root = newTrie();
  for (const p of paths) {
    let cur = root;
    for (const seg of p) {
      if (seg === null) cur = cur.any ??= newTrie();
      else {
        const existing = cur.keys.get(seg);
        const next = existing ?? newTrie();
        if (existing === undefined) cur.keys.set(seg, next);
        cur = next;
      }
    }
    cur.mark = true;
  }
  return root;
}

export interface ContentRefArgOptions {
  /** Also report address-shaped strings at UNMARKED positions as `media-arg-suspect` (warn). Default false. */
  readonly suspect?: boolean;
  /** Top-level keys to skip entirely (a key a host-accepted param replaced). */
  readonly skipKeys?: ReadonlySet<string>;
  /**
   * Is a step reference PROVEN to be a content reference: does `stepId` name a step of the graph
   * (not the step itself) whose tool declares its output at `path` to be one? Absent = nothing is
   * proven (fail closed): every step reference at a marked position is `media-arg-unproven-ref`.
   */
  readonly proven?: (stepId: string, path: ArgPath) => boolean;
  /** Called with the id of each step whose reference was ACCEPTED at a marked position. */
  readonly onProvenRef?: (stepId: string) => void;
}

const warnF = (code: string, message: string): Finding => ({ code, severity: "warn", message });
const errF = (code: string, message: string): Finding => ({ code, severity: "error", message });

/**
 * Check one step's `arguments` against the tool's {@link ContentRefEntry}.
 *
 *  - marked paths: a value at one must be absent / null, or a step reference that `opts.proven`
 *    accepts. A literal is `media-arg-literal`; an unproven reference (an echo / concat / dangling /
 *    self reference) is `media-arg-unproven-ref`. Both errors.
 *  - `"unknown"` (the schema mentions the marker but cannot be read): ANY string that is not a step
 *    reference or a relative-time token is `media-arg-literal`, wherever it sits.
 *  - `"unreadable"` (no marker mentioned): a string that is wholly a URL / locator / content address
 *    is `media-arg-literal`.
 *  - `suspect` (marked or unreadable entries only): an UNMARKED string that looks like an address or
 *    embeds one is `media-arg-suspect` (warn): a review hint, not a boundary.
 *
 * At most {@link MAX_LITERAL_FINDINGS} errors are listed; the rest are counted in a final "and N
 * more". Findings are value-free and never throw. LINEAR in the arguments: one pass, a trie of the
 * marked paths, a value budget, and a scan budget for the suspect heuristic.
 */
export function contentRefArgFindings(
  args: unknown,
  entry: ContentRefEntry,
  where: string,
  opts: ContentRefArgOptions = {}
): Finding[] {
  const out: Finding[] = [];
  const trie = typeof entry === "string" ? undefined : buildTrie(entry);
  let visited = 0;
  let scanned = 0;
  let suspects = 0;
  let errors = 0;
  let aborted = false;
  const refuse = (code: string, msg: string): void => {
    if (++errors <= MAX_LITERAL_FINDINGS) out.push(errF(code, `${where}: ${msg}`));
  };
  const walk = (v: unknown, nodes: readonly Trie[], depth: number, label: () => string): void => {
    if (aborted) return;
    if (++visited > MAX_ARG_VALUES || depth > MAX_ARG_DEPTH) {
      aborted = true;
      refuse(
        "media-arg-literal",
        "the arguments are too large or too deeply nested to check for content references"
      );
      return;
    }
    if (nodes.some((n) => n.mark)) {
      if (isLegitimateContentRef(v)) return;
      const ref = parseStepReference(v);
      if (ref === undefined)
        refuse(
          "media-arg-literal",
          `${label()} is a content-reference argument: bind it to a step reference or leave it out; a literal value is never accepted`
        );
      else if (ref.path !== undefined && opts.proven?.(ref.stepId, ref.path) === true)
        opts.onProvenRef?.(ref.stepId);
      else
        refuse(
          "media-arg-unproven-ref",
          `${label()} is a content-reference argument and its step reference does not name an output its tool declares to be a content reference`
        );
      return;
    }
    if (typeof v === "string") {
      if (STEP_TEMPLATE.test(v) || (v.length <= 32 && TIME_TOKEN.test(v))) return;
      if (entry === "unknown")
        refuse(
          "media-arg-literal",
          `${label()} is text and the tool's input schema mentions a content-reference marker but could not be fully read, so only step references are accepted`
        );
      else if (entry === "unreadable") {
        if (looksLikeLiteralRef(v))
          refuse(
            "media-arg-literal",
            `${label()} is a URL or content address and the tool's input schema could not be read, so it cannot be told apart from a content-reference argument`
          );
      } else if (
        opts.suspect === true &&
        suspects < MAX_SUSPECT_FINDINGS &&
        v.length <= MAX_EMBEDDED_SCAN
      ) {
        scanned += v.length;
        if (
          scanned <= MAX_SUSPECT_SCAN_CHARS &&
          (looksLikeLiteralRef(v) || containsEmbeddedRef(v))
        ) {
          suspects++;
          out.push(
            warnF(
              "media-arg-suspect",
              `${where}: ${label()} looks like a URL or content address; a content reference should come from a step reference, not text (review)`
            )
          );
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      const next = nodes.flatMap((n) => (n.any ? [n.any] : []));
      for (let i = 0; i < v.length; i++) walk(v[i], next, depth + 1, () => `${label()}[${i}]`);
      return;
    }
    if (typeof v === "object" && v !== null) {
      for (const k of Object.keys(v)) {
        if (depth === 0 && opts.skipKeys?.has(k)) continue;
        const next: Trie[] = [];
        for (const n of nodes) {
          const byKey = n.keys.get(k);
          if (byKey !== undefined) next.push(byKey);
          if (n.any !== undefined) next.push(n.any);
        }
        walk(
          (v as Record<string, unknown>)[k],
          next,
          depth + 1,
          () => `${label()}.${JSON.stringify(k)}`
        );
      }
    }
  };
  walk(args, trie ? [trie] : [], 0, () => "arguments");
  if (errors > MAX_LITERAL_FINDINGS)
    out.push(
      errF(
        "media-arg-literal",
        `${where}: and ${errors - MAX_LITERAL_FINDINGS} more content-reference problems`
      )
    );
  return out;
}

/**
 * A copy of `args` with every JSON `null` at a marked path removed (an object key deleted, an array
 * element dropped), so a tool never receives `null` where a reference belongs. Pure; the input is
 * untouched. Past the depth / value budgets the arguments are returned as they are (the check
 * already refused them).
 */
export function stripNullContentRefs(
  args: Record<string, unknown>,
  marked: readonly ArgPath[]
): Record<string, unknown> {
  if (marked.length === 0) return args;
  const trie = buildTrie(marked);
  let budget = MAX_ARG_VALUES;
  const go = (v: unknown, nodes: readonly Trie[], depth: number): unknown => {
    if (--budget < 0 || depth > MAX_ARG_DEPTH || nodes.length === 0) return v;
    if (Array.isArray(v)) {
      const next = nodes.flatMap((n) => (n.any ? [n.any] : []));
      if (next.length === 0) return v;
      const marked = next.some((n) => n.mark);
      return v.filter((x) => !(marked && x === null)).map((x) => go(x, next, depth + 1));
    }
    if (typeof v === "object" && v !== null) {
      const out: [string, unknown][] = [];
      for (const [k, x] of Object.entries(v)) {
        const next: Trie[] = [];
        for (const n of nodes) {
          const byKey = n.keys.get(k);
          if (byKey !== undefined) next.push(byKey);
          if (n.any !== undefined) next.push(n.any);
        }
        if (x === null && next.some((n) => n.mark)) continue;
        out.push([k, go(x, next, depth + 1)]);
      }
      return Object.fromEntries(out);
    }
    return v;
  };
  return go(args, [trie], 0) as Record<string, unknown>;
}

/** Marked top-level keys: the first segment of every marked path (a param replaces a whole top-level key). */
export function markedTopLevelKeys(marked: readonly ArgPath[]): Set<string> {
  const out = new Set<string>();
  for (const p of marked) if (typeof p[0] === "string") out.add(p[0]);
  return out;
}

const RANK: Record<"unreadable" | "unknown", number> = { unreadable: 1, unknown: 2 };

/** Union of two entries (the same tool offered twice): `"unknown"` absorbs `"unreadable"`, which absorbs paths. */
export function mergeContentRefEntries(
  a: ContentRefEntry | undefined,
  b: ContentRefEntry
): ContentRefEntry {
  if (a === undefined) return b;
  if (typeof a === "string" || typeof b === "string") {
    const ra = typeof a === "string" ? RANK[a] : 0;
    const rb = typeof b === "string" ? RANK[b] : 0;
    return ra >= rb ? (a as ContentRefEntry) : b;
  }
  const seen = new Map(a.map((p) => [JSON.stringify(p), p] as const));
  for (const p of b) seen.set(JSON.stringify(p), p);
  return [...seen.values()];
}

/** The table's input entry for a tool, own keys only. */
export const contentRefEntry = (
  table: ContentRefTable | undefined,
  key: string
): ContentRefEntry | undefined =>
  table !== undefined && Object.hasOwn(table.args, key) ? table.args[key] : undefined;

/** The table's declared output paths for a tool, own keys only. */
export const contentRefProduces = (
  table: ContentRefTable | undefined,
  key: string
): readonly ArgPath[] | undefined =>
  table?.produces !== undefined && Object.hasOwn(table.produces, key)
    ? table.produces[key]
    : undefined;

/** The `proven` predicate for one provider graph: the step exists, is not `selfId`, and its tool produces a ref at the path. */
export function provenIn(
  table: ContentRefTable | undefined,
  steps: ReadonlyMap<string, { readonly kind?: string | undefined; readonly toolName: string }>,
  selfId: string,
  toolKeyOf: (s: { readonly kind?: string | undefined; readonly toolName: string }) => string
): (stepId: string, path: ArgPath) => boolean {
  return (stepId, path) => {
    if (stepId === selfId) return false;
    const step = steps.get(stepId);
    if (step === undefined) return false;
    const produced = contentRefProduces(table, toolKeyOf(step));
    return produced?.some((p) => pathCovers(p, path)) === true;
  };
}

const isPath = (p: unknown): p is ArgPath =>
  Array.isArray(p) &&
  p.length <= MAX_SCHEMA_PATH_DEPTH + 1 &&
  p.every((s) => s === null || typeof s === "string");

/**
 * Re-read a persisted {@link ContentRefTable} (`JSON.parse` of what a host stored). Strict and total:
 * anything that is not exactly a table is `undefined`, never a partly-trusted one (a host must treat
 * `undefined` as an error, not as "nothing marked").
 */
export function parseContentRefTable(json: unknown): ContentRefTable | undefined {
  if (!isObj(json) || !isObj(json.args)) return undefined;
  const args: Record<string, ContentRefEntry> = Object.create(null);
  for (const [k, v] of Object.entries(json.args)) {
    if (v === "unknown" || v === "unreadable") args[k] = v;
    else if (Array.isArray(v) && v.length <= MAX_CONTENT_REF_PATHS && v.every(isPath))
      args[k] = v as ArgPath[];
    else return undefined;
  }
  let produces: Record<string, readonly ArgPath[]> | undefined;
  if (json.produces !== undefined) {
    if (!isObj(json.produces)) return undefined;
    produces = Object.create(null);
    for (const [k, v] of Object.entries(json.produces)) {
      if (Array.isArray(v) && v.length <= MAX_CONTENT_REF_PATHS && v.every(isPath))
        (produces as Record<string, readonly ArgPath[]>)[k] = v as ArgPath[];
      else return undefined;
    }
  }
  return { args, ...(produces !== undefined && { produces }) };
}
