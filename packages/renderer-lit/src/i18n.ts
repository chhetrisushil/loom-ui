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

/**
 * Today's translation seam: IDENTITY. There is no host override — a message catalogue is app
 * infrastructure this package does not load. `fallback` is the English text of a structured key
 * (`row.one`), so such a key never leaks as the spoken/visible string.
 */
export function t(key: string, fallback?: string): string {
  return fallback ?? key;
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
  for (const l of [...listeners]) l(next);
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
