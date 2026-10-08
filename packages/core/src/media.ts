import { type CurrentHead, actionFreshness } from "./action";
import type { SemanticEntry, SurfaceResolution } from "./catalog";
import type { Finding } from "./experience";
import {
  MAX_DECLARED_MEDIA_BYTES,
  MAX_MEDIA_NAME_LENGTH,
  MEDIA_INPUT_KIND,
  MEDIA_KINDS,
  type MediaKind,
  type MediaRef,
  isMediaRef,
} from "./mediaRef";

// The rest of the media surface: text, the host seams, limits, URL safety, the composition guard and
// the catalogue entries. The CONTRACT itself lives in `mediaRef.ts` (it is part of `checkKindValue`,
// so it rides in every client bundle); everything here is imported from `@loom-ui/core/media` only by
// the code that needs it, so the hydration client does not pay for it.
export * from "./mediaRef";

// ── Text and size shown to a reader ─────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/** Untrusted display text: controls, bidi overrides and zero-width marks become a space; whitespace collapses; bounded. */
export function cleanMediaText(text: unknown, max = MAX_MEDIA_NAME_LENGTH): string {
  if (typeof text !== "string") return "";
  const clean = text
    .slice(0, max * 4)
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...clean];
  return points.length <= max ? clean : `${points.slice(0, max - 1).join("")}…`;
}

/** A download file name from untrusted text: no path separators or leading dots, bounded; `fallback` when nothing is left. */
export function safeFileName(text: unknown, fallback = "download"): string {
  const base = cleanMediaText(text)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return base === "" ? fallback : base;
}

/** A byte count for a reader, in fixed binary units and locale (`1.5 MiB`): the same text on every surface. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const text = n >= 100 || Number.isInteger(n) ? Math.round(n).toString() : n.toFixed(1);
  return `${text} ${units[i]}`;
}

/** What a media value is, as one line of text (shared by the terminal surface and a screen reader). */
export function describeMedia(kind: string, ref: MediaRef): string {
  const label = kind === "File" ? "file" : kind.toLowerCase();
  const name = cleanMediaText(ref.name);
  const meta = [ref.mediaType, ref.size === undefined ? "" : formatBytes(ref.size)].filter(
    (s) => s !== ""
  );
  return `${label}${name === "" ? "" : ` ${name}`} (${meta.join(", ")})`;
}

// ── The host seams ────────────────────────────────────────────────────────────

/** What a resolver is asked. It carries no viewer: the host builds a resolver per viewer session and authorises there. */
export interface MediaRequest {
  /** The ref, already validated against the kind's contract. */
  readonly ref: MediaRef;
  /** The widget kind asking (`Image`…). */
  readonly kind: string;
  /** The compiled widget's id. */
  readonly widgetId: string;
  /** `"display"` (inline element) or `"download"` (a link the user follows). */
  readonly purpose: "display" | "download";
}

/**
 * The host's answer. `ok: false` carries NO reason a renderer shows: denied, missing and unavailable
 * look identical to the viewer (a distinction would be an existence oracle for an address).
 */
export type MediaResolution =
  | {
      readonly ok: true;
      /**
       * A viewer-scoped URL (short-lived and signed, or same-origin behind the host's own auth). Checked
       * by {@link checkMediaUrl} before use; loom-ui never builds one from an address.
       */
      readonly url: string;
      /**
       * `true` only when the HOST vouches for the bytes (it produced them itself). Anything else, and
       * anything whose ref claims `origin: "user"`, is shown as UNTRUSTED content.
       */
      readonly trusted?: boolean;
      /** The size the host observed; checked against the policy as well. */
      readonly size?: number;
    }
  | { readonly ok: false; readonly reason?: "denied" | "not-found" | "unavailable" };

/**
 * HOST CODE that turns a ref into a URL the current viewer may load, or refuses. It MUST authorise
 * (the content store has no tenancy of its own: ADR 0120). May throw / reject: that reads as `ok:false`.
 */
export type MediaResolver = (
  request: MediaRequest,
  options: { readonly signal: AbortSignal }
) => Promise<MediaResolution>;

/** Metadata of a file a user chose, before any byte leaves the page. */
export interface UploadCandidate {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}
export interface MediaUploadRequest {
  readonly candidate: UploadCandidate;
  /** The platform file object, opaque to loom-ui (a `Blob`/`File` in a browser): handed to the host, never read or stored here. */
  readonly body: unknown;
  readonly widgetId: string;
}
export type MediaUploadResult =
  | { readonly ok: true; readonly ref: unknown }
  | { readonly ok: false; readonly reason?: string };

/**
 * HOST CODE that stores the bytes (authorising, scanning, size-limiting) and returns a {@link MediaRef}.
 * loom-ui stores no bytes. The returned ref is validated and re-stamped `origin: "user"`.
 */
export type MediaUploadHandler = (
  request: MediaUploadRequest,
  options: { readonly signal: AbortSignal }
) => Promise<MediaUploadResult>;

/** The action type a media input emits; its payload is `{ ref: MediaRef }`. */
export const MEDIA_ATTACH_ACTION = "MEDIA_ATTACH";

// ── Limits and URL safety ────────────────────────────────────────────────────────

/** What a renderer will display. `maxBytes` is per kind; a declared size above it is refused BEFORE the resolver is called. */
export interface MediaPolicy {
  readonly maxBytes?: Partial<Record<MediaKind, number>>;
  /** `"mark"` (default) draws untrusted media with an untrusted marker; `"block"` draws a placeholder instead. */
  readonly untrusted?: "mark" | "block";
  /** Accept `http:` URLs (default: https and blob only). */
  readonly allowInsecure?: boolean;
  /** Accept private / loopback / link-local hosts (default: refused). A development switch. */
  readonly allowPrivateHosts?: boolean;
  /** Accept a same-origin `/path` URL (default true). */
  readonly allowRelative?: boolean;
  /**
   * Accept a same-origin `/path` or `blob:` URL for media that is NOT trusted (default false). Such a
   * URL runs in the app's own origin: if it is ever opened in a tab, active content in it (HTML,
   * SVG...) would execute with the app's cookies. Untrusted media is served cross-origin.
   */
  readonly allowSameOriginUntrusted?: boolean;
  /**
   * The app's own origin (`https://app.example`). The web surface defaults to `location.origin`; a
   * terminal has none, so set it there if untrusted absolute URLs on the app origin must be refused.
   */
  readonly appOrigin?: string;
}

/**
 * Is `url` (already accepted by {@link checkMediaUrl}) served from the app's own origin? A `/path` and a
 * `blob:` URL always are; an ABSOLUTE `https://app.example/...` is when its origin equals `appOrigin`.
 * Without an `appOrigin` an absolute URL is judged cross-origin. What this cannot see: a cross-origin
 * URL that redirects back to the app (a server-side matter: the resolver must not mint redirecting
 * URLs for untrusted media), and a DIFFERENT origin that shares the app's cookie scope (a sibling
 * subdomain an attacker can influence): serve untrusted media from a registrable domain of its own.
 */
export function isSameOriginMediaUrl(url: string, appOrigin?: string): boolean {
  if (url.startsWith("/") || url.startsWith("blob:")) return true;
  if (appOrigin === undefined) return false;
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

/**
 * Media types that execute or script in a browser when opened: markup (`text/html`, any `+xml`,
 * `text/xml`, `application/xml`), SVG, script types and Flash. Untrusted media of these types is
 * never drawn, whatever element would hold it: the same bytes opened in a tab are a page.
 */
export function isActiveMediaType(mediaType: string): boolean {
  // The ESSENCE: parameters (`text/html; charset=x`) and case do not change what a browser does.
  const t = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    t === "text/html" ||
    t === "text/xsl" ||
    t === "application/hta" ||
    t === "text/x-scriptlet" ||
    t === "text/cache-manifest" ||
    t === "text/xml" ||
    t === "application/xml" ||
    t === "application/xhtml+xml" ||
    t === "image/svg+xml" ||
    t === "application/x-shockwave-flash" ||
    t.endsWith("+xml") ||
    t.includes("javascript") ||
    t.includes("ecmascript")
  );
}

export const DEFAULT_MEDIA_MAX_BYTES: Readonly<Record<MediaKind, number>> = Object.freeze({
  Image: 32 * 1024 * 1024,
  Audio: 256 * 1024 * 1024,
  Video: 2 * 1024 * 1024 * 1024,
  File: 1024 * 1024 * 1024,
});

export const maxBytesFor = (kind: MediaKind, policy?: MediaPolicy): number =>
  policy?.maxBytes?.[kind] ?? DEFAULT_MEDIA_MAX_BYTES[kind];

const PRIVATE_NAME =
  /^(?:localhost|.*\.localhost|localhost\.localdomain|.*\.localdomain|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/;

/** Is a dotted-decimal IPv4 (given as four octets) in a range a viewer's browser must not be pointed at? */
function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast 224/4, reserved 240/4, 255.255.255.255
  );
}

/** Expand an IPv6 literal to eight 16-bit groups, or undefined if malformed. */
function expandV6(h: string): number[] | undefined {
  let text = h;
  // A trailing dotted-quad becomes two hex groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return undefined;
    text = `${text.slice(0, v4.index)}${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(((o[2] as number) << 8) | (o[3] as number)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? (halves[1] as string).split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map(
    (g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN)
  );
  return groups.length === 8 && groups.every((n) => Number.isInteger(n)) ? groups : undefined;
}

function privateV6(h: string): boolean {
  const g = expandV6(h);
  if (g === undefined) return true; // unparseable: refuse
  const v4of = (hi: number, lo: number): boolean => privateV4(hi >> 8, hi & 255, lo >> 8);
  const zero = (from: number, to: number): boolean => g.slice(from, to).every((n) => n === 0);
  if (zero(0, 5)) return true; // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (v4-mapped)
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
    return zero(2, 6) ? v4of(g[6] as number, g[7] as number) : false; // NAT64: embedded v4
  }
  if (g[0] === 0x2001 && g[1] === 0) return true; // 2001:0::/32 Teredo (embeds a client address)
  if (g[0] === 0x2002) return v4of(g[1] as number, g[2] as number); // 6to4: embedded v4
  const top = g[0] as number;
  return (
    (top & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (top & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (top & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (top & 0xff00) === 0xff00 // multicast
  );
}

function privateHost(hostname: string): boolean {
  let h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // `localhost.` is the same host as `localhost`: trailing root dots are not a different name.
  h = h.replace(/\.+$/, "");
  if (h.includes(":")) return privateV6(h);
  if (!h.includes(".")) return true; // single label: intranet
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  // `URL` has already normalised every numeric IPv4 spelling to dotted decimal.
  if (m) return privateV4(Number(m[1]), Number(m[2]), Number(m[3]));
  // DNS names that RESOLVE to a private address (nip.io style) cannot be seen here: that is the resolver's job.
  return PRIVATE_NAME.test(h);
}

/**
 * Whether a resolver's `url` may be handed to an element. https (http only with `allowInsecure`),
 * `blob:`, or a same-origin absolute path; never `javascript:`/`data:`/`file:`, never credentials in
 * the URL, and (by default) never a private, loopback or link-local host — a resolver bug must not
 * turn the viewer's browser into an SSRF probe of the host's network. Returns the normalised URL.
 */
export function checkMediaUrl(
  raw: unknown,
  policy?: MediaPolicy
): { ok: true; url: string } | { ok: false } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return { ok: false };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing controls is the point
  if (/[\u0000-\u001f\u007f-\u009f\s\\]/.test(raw)) return { ok: false };
  if (raw.startsWith("/")) {
    if (raw.startsWith("//") || policy?.allowRelative === false) return { ok: false };
    return { ok: true, url: raw };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (u.username !== "" || u.password !== "") return { ok: false };
  if (u.protocol === "blob:") return { ok: true, url: u.href };
  if (u.protocol !== "https:" && !(u.protocol === "http:" && policy?.allowInsecure === true))
    return { ok: false };
  if (policy?.allowPrivateHosts !== true && privateHost(u.hostname)) return { ok: false };
  return { ok: true, url: u.href };
}

// ── The catalogue and the composition-time guard ──────────────────────────────────

/** The props a model-composed media node may carry. Never an address, URL, source or autoplay. */
export const MEDIA_ALLOWED_PROPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Image: ["alt", "caption"],
  Audio: ["caption"],
  Video: ["caption"],
  File: ["caption"],
  MediaInput: ["accept", "maxBytes", "label"],
});

/** The text-valued props of the media kinds (a `LocalizedText` is allowed there; resolved at compile). */
export const MEDIA_TEXT_PROPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Image: ["alt", "caption"],
  Audio: ["caption"],
  Video: ["caption"],
  File: ["caption"],
  MediaInput: ["label"],
});

// A whole string that IS a locator or an address, wherever the model put it.
const LITERAL_REF =
  /^(?:[a-z][a-z0-9+.-]*:\/\/\S*|(?:data|blob|javascript|file|vbscript):\S*|[a-z0-9_-]{3,16}:[0-9a-f]{16,}|\/\/\S+)$/i;
const looksLikeLiteralRef = (s: string): boolean => LITERAL_REF.test(s.trim());

const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;
/** Longest text `containsEmbeddedRef` scans; anything longer is reported by its callers, not scanned. */
export const MAX_EMBEDDED_SCAN = 4096;

// Every pattern here is LINEAR in the text: either a regex with no nested/overlapping quantifier, or
// one of the two hand-written scanners below (a `scheme://` and a `host.tld/path` regex each backtrack
// quadratically on `a.a.a.…`). Do not "simplify" them back into one regex.
const SIMPLE = [
  /\b(?:data|blob|javascript|vbscript|file):\S/i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i,
  /\b[a-z0-9]{3,10}:[0-9a-f]{16,}\b/i, // algo:hex content address
  /\bbaf[a-z2-7]{20,}/, // base32 CID
  /\bQm[1-9A-HJ-NP-Za-km-z]{40,}/, // base58 CIDv0
];

const isAlpha = (c: number): boolean => c >= 97 && c <= 122; // a-z (input is lower-cased)
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0;

/** `scheme://x`: an occurrence of `://` right after a run of scheme characters holding a letter, then a non-space. */
function hasSchemeLocator(t: string): boolean {
  for (let i = t.indexOf("://"); i !== -1; i = t.indexOf("://", i + 1)) {
    const after = t.charCodeAt(i + 3);
    if (Number.isNaN(after) || isSpace(after)) continue;
    let sawLetter = false;
    for (let j = i - 1; j >= 0; j--) {
      const c = t.charCodeAt(j);
      if (isAlpha(c)) sawLetter = true;
      else if (!(isDigit(c) || c === 43 || c === 45 || c === 46)) break; // + - .
    }
    if (sawLetter) return true;
  }
  return false;
}

/** `label.tld/x`: a `/` right after a letters-only TLD (2+), a dot, and a host label, then a non-space. */
function hasHostPath(t: string): boolean {
  for (let i = t.indexOf("/"); i !== -1; i = t.indexOf("/", i + 1)) {
    const after = t.charCodeAt(i + 1);
    if (Number.isNaN(after) || isSpace(after)) continue;
    let j = i - 1;
    while (j >= 0 && isAlpha(t.charCodeAt(j))) j--;
    if (i - 1 - j < 2 || j < 1 || t.charCodeAt(j) !== 46) continue; // need 2+ letters, then "."
    const before = t.charCodeAt(j - 1);
    if (isAlpha(before) || isDigit(before)) return true;
  }
  return false;
}

/**
 * Does `text` CONTAIN a URL, a scheme-prefixed locator, a bare `host/path`, a `www.` host, an
 * `algo:hex` content address or a CID? Compatibility-normalised first (fullwidth `ｈｔｔｐ：／／`) with
 * invisible characters removed. LINEAR time, and text over {@link MAX_EMBEDDED_SCAN} characters is
 * not scanned but reported as embedding (fail closed). A HINT for composition-time review, not a
 * security boundary: the boundary is that a reference only ever comes from a binding and the host's
 * resolver. Known false positives: dotted names followed by a slash read as `host.tld/path`
 * (`Node.js/React`), and an `algo:hex` shape is any 3-10 character tag with 16+ hex digits.
 */
export function containsEmbeddedRef(text: string): boolean {
  if (text.length > MAX_EMBEDDED_SCAN) return true;
  const t = text.normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
  // `toLowerCase` would hide the case-sensitive CID shapes; test those on the original too.
  const raw = text.normalize("NFKC").replace(INVISIBLE, "");
  return hasSchemeLocator(t) || hasHostPath(t) || SIMPLE.some((re) => re.test(t) || re.test(raw));
}

function textValues(props: Readonly<Record<string, unknown>>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, raw] of Object.entries(props)) {
    if (typeof raw === "string") out.push([k, raw]);
    else if (typeof raw === "object" && raw !== null) {
      const f = (raw as { fallback?: unknown }).fallback;
      if (typeof f === "string") out.push([k, f]);
    }
  }
  return out;
}

/**
 * WARN-level: a non-media node whose text props embed a URL or address. Often legitimate (a docs
 * link in a note); worth a reviewer's eye because the same text could have smuggled a reference.
 */
export function embeddedRefWarnings(
  nodeId: string,
  props: Readonly<Record<string, unknown>>
): Finding[] {
  return textValues(props)
    .filter(([, v]) => containsEmbeddedRef(v))
    .map(([k, v]) => ({
      code: v.length > MAX_EMBEDDED_SCAN ? "text-too-long-to-scan" : "embedded-ref",
      severity: "warn" as const,
      message:
        v.length > MAX_EMBEDDED_SCAN
          ? `"${nodeId}": prop "${k}" is over ${MAX_EMBEDDED_SCAN} characters and is not scanned for embedded references`
          : `"${nodeId}": prop "${k}" embeds a URL or address — references come from bindings, not text`,
      nodeId,
    }));
}

/** A `MediaInput` `accept` entry: `type/subtype` or `type/*`. */
export const ACCEPT_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;

/**
 * Findings for a media node's props, against the framework's allow-list (independent of what the
 * catalogue declares): an unknown prop (`src`, `address`, `url`, `autoplay`…) or a prop whose whole
 * value is a locator / content address is an ERROR — a composer cannot author a media reference.
 */
export function mediaPropFindings(
  kind: string,
  nodeId: string,
  props: Readonly<Record<string, unknown>>
): Finding[] {
  const allowed = MEDIA_ALLOWED_PROPS[kind];
  if (allowed === undefined) return [];
  const out: Finding[] = [];
  const err = (code: string, message: string): void => {
    out.push({ code, severity: "error", message, nodeId });
  };
  for (const key of Object.keys(props)) {
    if (!allowed.includes(key)) {
      err(
        "media-prop-forbidden",
        `"${nodeId}": a ${kind} takes no "${key}" prop — media comes only from its bound value, never from the node`
      );
      continue;
    }
    const raw = props[key];
    // A LocalizedText `{ key, fallback }` shows its fallback: a locator hidden there is the same literal.
    const value =
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { fallback?: unknown }).fallback === "string"
        ? (raw as { fallback: string }).fallback
        : raw;
    if (typeof value === "string" && looksLikeLiteralRef(value))
      err(
        "media-literal-ref",
        `"${nodeId}": prop "${key}" is a literal address or URL — a media reference may only come from a binding`
      );
    else if (typeof value === "string" && key !== "accept" && value.length > MAX_EMBEDDED_SCAN)
      err(
        "media-prop-too-long",
        `"${nodeId}": prop "${key}" is over ${MAX_EMBEDDED_SCAN} characters: media text is short, and long text is not scanned`
      );
    else if (typeof value === "string" && key !== "accept" && containsEmbeddedRef(value))
      err(
        "media-embedded-ref",
        `"${nodeId}": prop "${key}" embeds a URL or address — a media reference may only come from a binding`
      );
    if (kind === MEDIA_INPUT_KIND && key === "accept") {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > 16 ||
        !value.every((p) => typeof p === "string" && ACCEPT_PATTERN.test(p))
      )
        err(
          "media-prop-shape",
          `"${nodeId}": accept is a short list of type/subtype or type/* patterns`
        );
    }
    if (kind === MEDIA_INPUT_KIND && key === "maxBytes") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value <= 0 ||
        value > MAX_DECLARED_MEDIA_BYTES
      )
        err("media-prop-shape", `"${nodeId}": maxBytes is a positive integer`);
    }
  }
  return out;
}

/** Does a file of `mediaType` satisfy an `accept` list (absent = anything)? Pure, for the upload control. */
export function matchesAccept(mediaType: string, accept: readonly string[] | undefined): boolean {
  if (accept === undefined) return true;
  return accept.some((p) =>
    p.endsWith("/*") ? mediaType.startsWith(p.slice(0, -1)) : p === mediaType
  );
}

/** The version the media entries declare; bump with the kind's props or value contract. */
export const MEDIA_TYPE_VERSION = "1.0.0";

/**
 * The semantic entries for the media kinds, ready to splice into a catalogue's `entries`
 * (`Image`, `Audio`, `Video`, `File`, `MediaInput`, each `@1.0.0`). A planner is offered media ONLY
 * by including these: a catalogue without them cannot compose a media node. The four display types
 * require a binding; `MediaInput` takes none. `surfaces` names the surfaces to resolve (default `web`
 * and `terminal`, the two with first-party renderers); every one resolves to the framework kind.
 */
export function mediaCatalogEntries(
  options: { readonly surfaces?: readonly string[] } = {}
): SemanticEntry[] {
  const surfaces = options.surfaces ?? ["web", "terminal"];
  const entry = (kind: string, binding: "required" | "none"): SemanticEntry => {
    const props = MEDIA_ALLOWED_PROPS[kind] as readonly string[];
    const resolution: SurfaceResolution = { kind, props: [...props], binding };
    return {
      name: kind,
      version: MEDIA_TYPE_VERSION,
      props: [...props],
      binding,
      textProps: [...(MEDIA_TEXT_PROPS[kind] ?? [])],
      surfaces: Object.fromEntries(surfaces.map((s) => [s, resolution])),
    };
  };
  return [...MEDIA_KINDS.map((k) => entry(k, "required")), entry(MEDIA_INPUT_KIND, "none")];
}

// ── Host-side duties ─────────────────────────────────────────────────────────────

export type MediaAttachRefusal =
  | "not-an-attach" // not a MEDIA_ATTACH action, or no object payload
  | "not-media-input" // the widget it names is not an upload control
  | "bad-ref" // the payload ref is not a valid File MediaRef, or violates accept / maxBytes
  | "not-issued" // the host never issued this address to this principal
  | "stale"; // the action was not taken on the current view

/** What the host's upload handler recorded when it issued an address: the TRUTH about the bytes. */
export interface IssuedMedia {
  readonly mediaType: string;
  readonly size?: number;
}

/**
 * HOST-SIDE acceptance of a `MEDIA_ATTACH` action. The action is CLIENT INPUT: everything the
 * widget checked (type, size, `origin: "user"`) was checked in a browser the user controls. This is
 * the check that counts:
 *
 *  1. it is a `MEDIA_ATTACH` naming a widget that is an upload control (`isMediaInput`, if given),
 *     with a payload ref that re-parses as a `File` `MediaRef` (strict);
 *  2. `issued(address, principal)` returns the stored `{ mediaType, size? }` of an address THIS host's
 *     upload handler issued to THIS principal, or `undefined`. Without it a client could attach any
 *     address it has seen or guessed, or another user's;
 *  3. the CLIENT's `mediaType` and `size` are discarded and replaced by the stored ones (a client
 *     claiming `image/png` for a stored `text/html` changes nothing); `accept` / `maxBytes` are
 *     enforced on the stored values. The resolver's `Content-Type` must likewise come from the stored
 *     record, never from the ref;
 *  4. the action is `fresh` against `current` (`actionFreshness`);
 *  5. the accepted ref is re-stamped `origin: "user"`.
 *
 * Returns the ref to act on, or a typed refusal. Total: never throws.
 */
export function acceptMediaAttach<P>(
  action: unknown,
  options: {
    readonly issued: (address: string, principal: P) => IssuedMedia | undefined;
    readonly principal: P;
    readonly current: CurrentHead;
    readonly isMediaInput?: (widgetId: string) => boolean;
    readonly accept?: readonly string[];
    readonly maxBytes?: number;
  }
): { ok: true; ref: MediaRef; widgetId: string } | { ok: false; reason: MediaAttachRefusal } {
  try {
    const a = action as { type?: unknown; widgetId?: unknown; payload?: unknown } | null;
    if (typeof a !== "object" || a === null || a.type !== MEDIA_ATTACH_ACTION)
      return { ok: false, reason: "not-an-attach" };
    const payload = a.payload as { ref?: unknown } | null;
    if (typeof payload !== "object" || payload === null || typeof a.widgetId !== "string")
      return { ok: false, reason: "not-an-attach" };
    if (options.isMediaInput !== undefined && options.isMediaInput(a.widgetId) !== true)
      return { ok: false, reason: "not-media-input" };
    const claimed = payload.ref;
    if (!isMediaRef("File", claimed)) return { ok: false, reason: "bad-ref" };
    if (actionFreshness(a as never, options.current) !== "fresh")
      return { ok: false, reason: "stale" };
    const stored = options.issued(claimed.address, options.principal);
    if (typeof stored !== "object" || stored === null) return { ok: false, reason: "not-issued" };
    const truth: MediaRef = {
      address: claimed.address,
      mediaType: stored.mediaType,
      ...(stored.size !== undefined && { size: stored.size }),
      ...(claimed.name !== undefined && { name: claimed.name }),
      ...(claimed.alt !== undefined && { alt: claimed.alt }),
      origin: "user",
    };
    if (!isMediaRef("File", truth)) return { ok: false, reason: "bad-ref" };
    if (options.accept !== undefined && !matchesAccept(truth.mediaType, options.accept))
      return { ok: false, reason: "bad-ref" };
    if (options.maxBytes !== undefined && truth.size !== undefined && truth.size > options.maxBytes)
      return { ok: false, reason: "bad-ref" };
    return { ok: true, ref: truth, widgetId: a.widgetId };
  } catch {
    return { ok: false, reason: "not-an-attach" };
  }
}

// ── File names vs their media type ──────────────────────────────────────────────

const RISKY_EXT = new Set(
  "exe msi bat cmd com scr pif js mjs jse vbs vbe wsf jar sh bash ps1 app dmg apk deb rpm lnk hta html htm xhtml svg xml dll iso reg".split(
    " "
  )
);
const EXT_ALIAS: Readonly<Record<string, readonly string[]>> = {
  "text/html": ["html", "htm"],
  "application/xhtml+xml": ["xhtml"],
  "image/svg+xml": ["svg"],
  "text/xml": ["xml"],
  "application/xml": ["xml"],
  "application/javascript": ["js", "mjs"],
  "text/javascript": ["js", "mjs"],
  "application/java-archive": ["jar"],
  "application/x-sh": ["sh"],
  "application/x-msdownload": ["exe", "dll"],
};

/**
 * A downloaded file's name checked against its media type. A name whose final extension is
 * executable or scriptable (`.exe`, `.html`, `.svg`, `.js`...) while the TYPE says something else
 * (`invoice.pdf.exe` as `application/pdf`) is a disguise: `mismatch` is true, `display` says the
 * type out loud and `download` drops the misleading extension. A matching or harmless extension is
 * untouched.
 */
export function checkFileName(
  name: unknown,
  mediaType: string
): { readonly display: string; readonly download: string; readonly mismatch: boolean } {
  const clean = safeFileName(name);
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(clean);
  const ext = m?.[1]?.toLowerCase();
  if (ext === undefined || !RISKY_EXT.has(ext))
    return { display: clean, download: clean, mismatch: false };
  const allowed = EXT_ALIAS[mediaType.toLowerCase()];
  if (allowed?.includes(ext) === true) return { display: clean, download: clean, mismatch: false };
  const stripped = safeFileName(clean.slice(0, -(ext.length + 1)));
  return { display: `${clean} (${mediaType})`, download: stripped, mismatch: true };
}
