// ── Media: the MediaRef value contract (U9) ──────────────────────
//
// Media is NEVER bytes in the Experience. A media widget is bound (like any data widget) to a handle
// whose hydrated VALUE is a {@link MediaRef}: an opaque content address plus the metadata a UI needs
// to decide what to draw (`mediaType`, `size`, `name`, `alt`). Bytes live in the host's content store
// (loom's `ContentStore`, ADR 0046; llm media parts, ADR 0120). How an address becomes something a
// browser can load is the HOST's decision, behind a {@link MediaResolver} — an authorising seam that
// returns a viewer-scoped URL. loom-ui never fetches an address and never treats one as a locator.
//
// THE LEAK MODEL. An address is a CAPABILITY ("whoever can name an address can read it": loom
// ADR 0120). It therefore travels only as a hydrated value, which the data boundary already gates:
// a handle the viewer may not see is never loaded, so its value (and the address in it) never reaches
// the store, the renderer, the seen log or a change description. It is NEVER a node prop (the model
// that composes a tree cannot author one: see {@link mediaPropFindings}), never part of a Blueprint,
// and never in a finding or an error message (every message here is value-free).
//
// Zod-free and DOM-free on purpose: a browser renderer gets the contract from `@loom-ui/core/browser` (it is part of `checkKindValue`),
// and the rest of the media surface from `@loom-ui/core/media`.

/** The kinds that DISPLAY a content ref. The widget kinds are framework-owned; an app catalogue names them. */
export const MEDIA_KINDS = ["Image", "Audio", "Video", "File"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
/** The kind that COLLECTS media from the user (an upload control): static, never bound. */
export const MEDIA_INPUT_KIND = "MediaInput";

export const isMediaKind = (kind: string): kind is MediaKind =>
  (MEDIA_KINDS as readonly string[]).includes(kind);
export const isMediaInputKind = (kind: string): boolean => kind === MEDIA_INPUT_KIND;

/** Who produced the media, as the value CLAIMS it. Informational only: it never grants trust (see {@link MediaResolution}). */
export type MediaOrigin = "host" | "tool" | "user";
const ORIGINS: readonly string[] = ["host", "tool", "user"];

/**
 * The value a media widget is bound to. Strict: a field outside this list (`data`, `bytes`, `url`…)
 * is refused, so raw bytes and locators cannot ride along into the store or the seen log.
 */
export interface MediaRef {
  /** Opaque content address (e.g. `sha256:<hex>`). A handle, not a locator: see {@link addressProblem}. */
  readonly address: string;
  /** Lower-case `type/subtype`, no parameters. The kind's family must match (`Image` → `image/*`). */
  readonly mediaType: string;
  /** Byte length, when known. */
  readonly size?: number;
  /** A display / download file name. Untrusted text: sanitised at render. */
  readonly name?: string;
  /** A text alternative. Untrusted text: sanitised at render. */
  readonly alt?: string;
  /** Who produced it, as claimed. Never grants trust. */
  readonly origin?: MediaOrigin;
}

export const MAX_ADDRESS_LENGTH = 512;
export const MAX_MEDIA_TYPE_LENGTH = 127;
export const MAX_MEDIA_NAME_LENGTH = 255;
export const MAX_MEDIA_ALT_LENGTH = 1000;
/** A sanity ceiling on a DECLARED size (1 TiB); a renderer's policy sets the real, much lower, limit. */
export const MAX_DECLARED_MEDIA_BYTES = 2 ** 40;

// An address is a handle drawn from a conservative alphabet; a locator (anything with a scheme
// followed by `//`, a protocol-relative `//`, or whitespace/control/quote characters) is refused so
// an address can never be mistaken for, or turned into, a URL to fetch.
const ADDRESS_ALPHABET = /^[A-Za-z0-9._~:+=/@-]+$/;
const LOCATOR = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** Why `address` is not an opaque content address, as a value-free message; `undefined` when it is. */
export function addressProblem(address: string): string | undefined {
  if (address.length === 0) return "address must not be empty";
  if (address.length > MAX_ADDRESS_LENGTH)
    return `address must be at most ${MAX_ADDRESS_LENGTH} characters`;
  if (!ADDRESS_ALPHABET.test(address)) return "address must be an opaque content address";
  if (LOCATOR.test(address) || address.includes("//") || address.startsWith("/"))
    return "address must be an opaque content address, not a locator";
  return undefined;
}

/** Why `mediaType` is not a bare lower-case `type/subtype`, value-free; `undefined` when it is. */
export function mediaTypeProblem(mediaType: string): string | undefined {
  if (mediaType.length > MAX_MEDIA_TYPE_LENGTH || !MEDIA_TYPE.test(mediaType))
    return "mediaType must be a lower-case type/subtype with no parameters";
  return undefined;
}

/** The media-type family a kind displays (`"image/"`), or undefined for a kind that takes any. */
export function mediaFamily(kind: string): string | undefined {
  switch (kind) {
    case "Image":
      return "image/";
    case "Audio":
      return "audio/";
    case "Video":
      return "video/";
    default:
      return undefined;
  }
}

export interface MediaIssue {
  readonly path: readonly string[];
  readonly message: string;
}

const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as never)[k] : undefined);

/**
 * Every way `value` fails the {@link MediaRef} contract for `kind`, in a fixed order. Value-free
 * messages (they reach a viewer's error state). This ONE function backs both the zod contract and
 * the zod-free one, so the two cannot drift.
 */
export function mediaValueIssues(kind: string, value: unknown): MediaIssue[] {
  const out: MediaIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    out.push({ path: [], message: "Expected a media reference object" });
    return out;
  }
  const v = value as object;
  const address = own(v, "address");
  if (typeof address !== "string") out.push({ path: ["address"], message: "address is required" });
  else {
    const p = addressProblem(address);
    if (p !== undefined) out.push({ path: ["address"], message: p });
  }
  const mediaType = own(v, "mediaType");
  if (typeof mediaType !== "string")
    out.push({ path: ["mediaType"], message: "mediaType is required" });
  else {
    const p = mediaTypeProblem(mediaType);
    if (p !== undefined) out.push({ path: ["mediaType"], message: p });
    else {
      const family = mediaFamily(kind);
      if (family !== undefined && !mediaType.startsWith(family))
        out.push({
          path: ["mediaType"],
          message: `mediaType must be ${family}* for this kind`,
        });
    }
  }
  const size = own(v, "size");
  if (size !== undefined) {
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0)
      out.push({ path: ["size"], message: "size must be a non-negative integer" });
    else if (size > MAX_DECLARED_MEDIA_BYTES)
      out.push({ path: ["size"], message: "size exceeds the declared-size ceiling" });
  }
  const name = own(v, "name");
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_MEDIA_NAME_LENGTH))
    out.push({
      path: ["name"],
      message: `name must be a string of at most ${MAX_MEDIA_NAME_LENGTH} characters`,
    });
  const alt = own(v, "alt");
  if (alt !== undefined && (typeof alt !== "string" || alt.length > MAX_MEDIA_ALT_LENGTH))
    out.push({
      path: ["alt"],
      message: `alt must be a string of at most ${MAX_MEDIA_ALT_LENGTH} characters`,
    });
  const origin = own(v, "origin");
  if (origin !== undefined && (typeof origin !== "string" || !ORIGINS.includes(origin)))
    out.push({ path: ["origin"], message: "origin must be host, tool or user" });
  // Strict: nothing outside the contract (bytes, a locator) may ride along into a store.
  const known = new Set(["address", "mediaType", "size", "name", "alt", "origin"]);
  for (const key of Object.keys(v))
    if (!known.has(key)) {
      out.push({ path: [], message: "unexpected field: a media reference carries no other data" });
      break;
    }
  return out;
}

/** The {@link MediaRef} verdict for `kind`, as a type guard (the contract, not a cast). */
export function isMediaRef(kind: string, value: unknown): value is MediaRef {
  return mediaValueIssues(kind, value).length === 0;
}
