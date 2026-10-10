import { type LuI18n, lookupMessage } from "@loom-ui/core/messages";

// ── Locale shim ───────────────────────────────────────────────────────────────
// Loading message catalogs and manifests is app infrastructure and stays with the host.
// The widgets here only need: a locale to format with, a change signal so an
// element re-renders when it changes, and the RTL question. `t` is identity — the widget's
// user-visible strings are the app's to localize.

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv"]);

let locale: string =
  typeof navigator !== "undefined" && typeof navigator.language === "string"
    ? navigator.language
    : "en-US";
const listeners = new Set<(locale: string) => void>();
let override: LuI18n | undefined;
function notify(): void {
  for (const l of [...listeners]) l(locale);
}

/**
 * The translation seam. With no host override it is IDENTITY (`fallback`, else the key). A host
 * installs one with {@link configureI18n}: its `messages` catalogue, then its `translate` function,
 * answer for the key; anything they do not answer stays English. `fallback` is the English text of a
 * structured key (`lu.plural.row.one`), so such a key never leaks as the spoken/visible string.
 * Widgets do not call this with literal text: they ask `say(key)` (see `say.ts`), whose English comes
 * from the one catalogue in `@loom-ui/core`.
 */
export function t(key: string, fallback?: string): string {
  return lookupMessage(override, key, fallback ?? key);
}

/**
 * The HOST override: a locale, a message catalogue and/or a translate function (see {@link LuI18n}).
 * Call it before mounting; calling it again swaps the override and re-renders every mounted element.
 * `configureI18n(undefined)` removes the override (English, the locale unchanged).
 */
export function configureI18n(next: LuI18n | undefined): void {
  override = next;
  if (next?.locale !== undefined && next.locale !== locale) locale = next.locale;
  notify();
}

export function currentLocale(): string {
  return locale;
}
export function formattingLocale(): string {
  return locale;
}
export function setLocale(next: string): void {
  if (next === locale) return;
  locale = next;
  notify();
}
export function onLocaleChange(listener: (locale: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function isRtl(l: string = locale): boolean {
  return RTL_LANGUAGES.has(l.split(/[-_]/)[0]?.toLowerCase() ?? "");
}
export function localeLabel(l: string): string {
  try {
    return new Intl.DisplayNames([l], { type: "language" }).of(l) ?? l;
  } catch {
    return l;
  }
}
/** Re-render a Lit element when the locale changes; detaches when the element disconnects. */
export function localized(host: {
  requestUpdate(): void;
  addController?(c: { hostConnected?(): void; hostDisconnected?(): void }): void;
}): void {
  let off: (() => void) | undefined;
  const controller = {
    hostConnected: () => {
      off = onLocaleChange(() => host.requestUpdate());
    },
    hostDisconnected: () => {
      off?.();
      off = undefined;
    },
  };
  if (host.addController) host.addController(controller);
  else controller.hostConnected();
}
