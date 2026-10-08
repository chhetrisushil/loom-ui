import type { SemanticEntry, SurfaceResolution } from "./catalog";
import type { Finding } from "./experience";
import {
  MAX_DECLARED_MEDIA_BYTES,
  MAX_MEDIA_NAME_LENGTH,
  MEDIA_INPUT_KIND,
  MEDIA_KINDS,
  type MediaKind,
  type MediaRef,
} from "./mediaRef";

// The rest of the media surface: text, the host seams, limits, URL safety, the composition guard and
// the catalogue entries. The CONTRACT itself lives in `mediaRef.ts` (it is part of `checkKindValue`,
// so it rides in every client bundle); everything here is imported from `@loom-ui/core/media` only by
// the code that needs it, so the hydration client does not pay for it.
export * from "./mediaRef";

// ── Text and size shown to a reader ─────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g;

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
}

export const DEFAULT_MEDIA_MAX_BYTES: Readonly<Record<MediaKind, number>> = Object.freeze({
  Image: 32 * 1024 * 1024,
  Audio: 256 * 1024 * 1024,
  Video: 2 * 1024 * 1024 * 1024,
  File: 1024 * 1024 * 1024,
});

export const maxBytesFor = (kind: MediaKind, policy?: MediaPolicy): number =>
  policy?.maxBytes?.[kind] ?? DEFAULT_MEDIA_MAX_BYTES[kind];

const PRIVATE_HOST =
  /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/i;

function privateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h.includes(":")) {
    // IPv6 literals: loopback, unspecified, unique-local, link-local, and v4-mapped.
    return (
      h === "::1" ||
      h === "::" ||
      /^f[cd][0-9a-f]{2}:/.test(h) ||
      /^fe[89ab][0-9a-f]:/.test(h) ||
      h.startsWith("::ffff:")
    );
  }
  // `URL` has already normalised every numeric IPv4 spelling to dotted decimal; a single-label host is intranet.
  if (!h.includes(".")) return true;
  return PRIVATE_HOST.test(h);
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
