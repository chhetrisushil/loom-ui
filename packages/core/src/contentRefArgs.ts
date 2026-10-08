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
// ONLY (3) a step reference, or (4) a param the HOST accepted (`acceptContentRefParam`: the value
// came out of `acceptMediaAttach`), or nothing (absent, or JSON null). Anything else at a marked
// position is a LITERAL, and is refused: a literal address, a time token, a number, an object. The
// argument hook is the host's own code and runs after the check; it may set whatever it likes.
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
  | { readonly status: "unknown"; readonly reason: string };

/** Marked paths per tool (`toolKey`); `"unknown"` = the schema could not be read (fail closed). */
export type ContentRefTable = Readonly<Record<string, readonly ArgPath[] | "unknown">>;

export const MAX_SCHEMA_NODES = 5000;
export const MAX_SCHEMA_PATH_DEPTH = 24;
export const MAX_CONTENT_REF_PATHS = 256;
/** Deepest `arguments` nesting {@link contentRefArgFindings} walks; deeper is refused. */
export const MAX_ARG_DEPTH = 64;
/** Most JSON values {@link contentRefArgFindings} visits in one step's arguments; more is refused. */
export const MAX_ARG_VALUES = 100_000;
const MAX_SUSPECT_SCAN_CHARS = 262_144;
const MAX_SUSPECT_FINDINGS = 8;

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

/** Does the keyword occur anywhere in `v`? Bounded: past the budget, assume it does (fail closed). */
function mentionsKeyword(v: unknown): boolean {
  const stack: unknown[] = [v];
  for (let n = 0; stack.length > 0; ) {
    if (++n > MAX_SCHEMA_NODES) return true;
    const cur = stack.pop();
    if (Array.isArray(cur)) for (const x of cur) stack.push(x);
    else if (isObj(cur)) {
      if (Object.hasOwn(cur, CONTENT_REF_KEYWORD)) return true;
      for (const x of Object.values(cur)) stack.push(x);
    }
  }
  return false;
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
export function contentRefPaths(schema: unknown): ContentRefPaths {
  if (schema === undefined) return { status: "ok", paths: [] };
  if (!isObj(schema) && typeof schema !== "boolean")
    return { status: "unknown", reason: "the input schema is not a JSON Schema object" };
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
        if (path.length === 0) throw new Unreadable("the marker is on the arguments object itself");
        if (found.size >= MAX_CONTENT_REF_PATHS && !found.has(JSON.stringify(path)))
          throw new Unreadable("the input schema marks too many content references");
        found.set(JSON.stringify(path), path);
        return;
      }
      if (m !== false) throw new Unreadable(`"${CONTENT_REF_KEYWORD}" must be true or false`);
    }
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
    if (isObj(s.dependentSchemas))
      for (const v of Object.values(s.dependentSchemas)) visit(v, path, stack);
  };
  try {
    visit(schema, [], []);
  } catch (e) {
    return {
      status: "unknown",
      reason: e instanceof Unreadable ? e.message : "the input schema could not be read",
    };
  }
  if (cyclic && (found.size > 0 || mentionsKeyword(schema)))
    return { status: "unknown", reason: "the input schema is recursive and carries the marker" };
  return { status: "ok", paths: [...found.values()] };
}

/** `arguments."a"[]."c"` — keys are tool-server text, so a key is shown only as a JSON string literal. */
export function formatArgPath(path: ArgPath): string {
  return `arguments${path.map((s) => (s === null ? "[]" : `.${JSON.stringify(s)}`)).join("")}`;
}

// ── Reading arguments ────────────────────────────────────────────────────────────

/** `{{steps.<id>.output[.<path>]}}` as a WHOLE string: the only step-reference form. Mirrors hydration's `STEP_TEMPLATE` (a hydration test pins them equal). */
export const STEP_TEMPLATE_SOURCE = "^\\{\\{steps\\.([^.}]+)\\.output(?:\\.(.+))?\\}\\}$";
const STEP_TEMPLATE = new RegExp(STEP_TEMPLATE_SOURCE);
const TIME_TOKEN_LIKE = /^\$now(?![A-Za-z0-9_])/;

/** May a value stand at a content-reference position? A whole-string step reference, or nothing (absent / null). */
export const isLegitimateContentRef = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && STEP_TEMPLATE.test(v));

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
}

const warnF = (code: string, message: string): Finding => ({ code, severity: "warn", message });
const errF = (code: string, message: string): Finding => ({ code, severity: "error", message });

/**
 * Check one step's `arguments`. `marked` is the tool's marked paths ({@link contentRefPaths}), or
 * `"unknown"` when its schema could not be read: then the marker positions are unknown too, so
 * (fail closed) ANY string that is wholly a URL / locator / content address is refused as
 * `media-arg-literal`, wherever it sits. Findings are value-free and never throw.
 *
 *  - `media-arg-literal` (error): a literal at a marked position (see the grammar at the top of this
 *    file), or arguments too large / deep to check.
 *  - `media-arg-suspect` (warn, `suspect` only): an UNMARKED string that looks like an address or
 *    embeds one. A review hint, not a boundary (the host's invoker authorises the call).
 *
 * LINEAR in the arguments: one pass, a trie of the marked paths, a value budget, and a scan budget
 * for the suspect heuristic.
 */
export function contentRefArgFindings(
  args: unknown,
  marked: readonly ArgPath[] | "unknown",
  where: string,
  opts: ContentRefArgOptions = {}
): Finding[] {
  const out: Finding[] = [];
  const trie = marked === "unknown" ? undefined : buildTrie(marked);
  let visited = 0;
  let scanned = 0;
  let suspects = 0;
  let aborted = false;
  const refuse = (msg: string): void => {
    out.push(errF("media-arg-literal", `${where}: ${msg}`));
  };
  const walk = (v: unknown, nodes: readonly Trie[], depth: number, label: () => string): void => {
    if (aborted) return;
    if (++visited > MAX_ARG_VALUES || depth > MAX_ARG_DEPTH) {
      aborted = true;
      refuse("the arguments are too large or too deeply nested to check for content references");
      return;
    }
    if (nodes.some((n) => n.mark)) {
      if (!isLegitimateContentRef(v))
        refuse(
          `${label()} is a content-reference argument: bind it to a step reference or leave it out; a literal value is never accepted`
        );
      return;
    }
    if (typeof v === "string") {
      if (STEP_TEMPLATE.test(v) || (TIME_TOKEN_LIKE.test(v) && v.length <= 32)) return;
      if (trie === undefined) {
        if (looksLikeLiteralRef(v))
          refuse(
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
  return out;
}

/** Marked top-level keys: the first segment of every marked path (a param replaces a whole top-level key). */
export function markedTopLevelKeys(marked: readonly ArgPath[]): Set<string> {
  const out = new Set<string>();
  for (const p of marked) if (typeof p[0] === "string") out.add(p[0]);
  return out;
}

/** Union of two tool entries (the same tool offered twice): `"unknown"` absorbs. */
export function mergeContentRefEntries(
  a: readonly ArgPath[] | "unknown" | undefined,
  b: readonly ArgPath[] | "unknown"
): readonly ArgPath[] | "unknown" {
  if (a === undefined) return b;
  if (a === "unknown" || b === "unknown") return "unknown";
  const seen = new Map(a.map((p) => [JSON.stringify(p), p] as const));
  for (const p of b) seen.set(JSON.stringify(p), p);
  return [...seen.values()];
}

/** The table entry for a tool, own keys only. */
export const contentRefEntry = (
  table: ContentRefTable | undefined,
  key: string
): readonly ArgPath[] | "unknown" | undefined =>
  table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
