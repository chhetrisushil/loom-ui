import { MAX_MEDIA_NAME_LENGTH, type MediaRef } from "./mediaRef";

// The text a reader sees about a media value: name cleaning, byte counts and the one-line description.
// Its own module (re-exported by `media.ts`) so the chat widgets, which describe an attachment but never
// resolve or upload one, do not carry the URL policy that sits beside it.

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
