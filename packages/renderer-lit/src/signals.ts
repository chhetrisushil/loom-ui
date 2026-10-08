// `@loom-ui/renderer-lit/signals` — drive a `SignalCollector` from the DOM a `renderBlueprintDom`
// handle owns (U11), opt-in like the reference containers and the media widgets: a page that collects
// no interaction signals does not pay for a byte of it.
//
//   import { SignalCollector } from "@loom-ui/core/signals";
//   import { observeSignals } from "@loom-ui/renderer-lit/signals";
//   const collector = new SignalCollector({ sink: (batch) => fetch("/signals", { method: "POST", body: JSON.stringify(batch) }) });
//   const signals = observeSignals(handle, collector, { placeholders: result.fingerprint.placeholderNodes });
//   // after handle.update(next): signals.refresh();   // re-reads the version and the widgets
//
// What it watches, all through ONE root listener / one IntersectionObserver:
//   - EXPOSURE: a widget at least half inside the viewport (ratio ≥ 0.5) while the page is visible.
//     With no IntersectionObserver nothing is claimed — an exposure is never assumed;
//   - DWELL: the time a widget stays that visible, ACCUMULATED client-side; only a bucket leaves;
//   - ENGAGEMENT: a click anywhere in a widget; a `<details>` opening inside one (expand).
// It reads node ids from `data-widget-id` and nothing else from the DOM — no text, no values.
// A restricted node is reported under the alias it already has, flagged by the collector.

import type { SignalCollector } from "@loom-ui/core/signals";

export interface ObserveSignalsOptions {
  /** `CompileResult.fingerprint.placeholderNodes`: ids drawn as restricted placeholders. */
  readonly placeholders?: Iterable<string>;
  /** The compile fingerprint of this view (`compileFingerprint`), stamped on every batch. */
  readonly compile?: string;
  /** Monotonic ms. Default `performance.now()`. Inject one in tests. */
  readonly now?: () => number;
  /** Test seam. Default `globalThis.IntersectionObserver`. */
  readonly IntersectionObserver?: typeof IntersectionObserver;
  /** Flush when the page is hidden or hides (default true) — the moment a tab may never come back. */
  readonly flushOnHide?: boolean;
}

export interface SignalObserver {
  /** Re-read the Blueprint id (a new version starts a new view) and re-observe the widgets. */
  refresh(): void;
  dispose(): void;
}

const VISIBLE = 0.5;

/** `<experienceId>@<versionHash|unsealed>`, as core's `parseBlueprintId` (kept local: importing it would pull core's whole browser entry into this one). */
function parseBlueprintId(id: string): { experienceId: string; versionHash: string } {
  const at = id.lastIndexOf("@");
  if (at < 0) return { experienceId: id, versionHash: "" };
  const hash = id.slice(at + 1);
  return { experienceId: id.slice(0, at), versionHash: hash === "unsealed" ? "" : hash };
}

export function observeSignals(
  handle: { readonly element: HTMLElement },
  collector: SignalCollector,
  opts: ObserveSignalsOptions = {}
): SignalObserver {
  const root = handle.element;
  const now =
    opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const IO =
    opts.IntersectionObserver ??
    (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  const placeholders = opts.placeholders === undefined ? undefined : [...opts.placeholders];
  /** widget id → when it became visible (ms), while it is. */
  const since = new Map<string, number>();
  const watched = new Set<Element>();
  let disposed = false;

  const hidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  const idOf = (el: Element | null): string | undefined => {
    const host = el?.closest?.("[data-widget-id]") as HTMLElement | null | undefined;
    const id = host?.dataset.widgetId;
    return host !== null && host !== undefined && root.contains(host) && id !== undefined
      ? id
      : undefined;
  };

  const endDwell = (id: string): void => {
    const t0 = since.get(id);
    if (t0 === undefined) return;
    since.delete(id);
    collector.dwell(id, Math.max(0, now() - t0));
  };

  const io =
    IO === undefined
      ? undefined
      : new IO(
          (entries) => {
            if (disposed) return;
            for (const e of entries) {
              const id = idOf(e.target);
              if (id === undefined) continue;
              const on = e.isIntersecting && e.intersectionRatio >= VISIBLE && !hidden();
              if (on && !since.has(id)) {
                collector.expose(id);
                since.set(id, now());
              } else if (!on) endDwell(id);
            }
          },
          { threshold: [0, VISIBLE, 1] }
        );

  const scan = (): void => {
    if (io === undefined) return;
    const live = new Set<Element>(root.querySelectorAll("[data-widget-id]"));
    for (const el of watched)
      if (!live.has(el)) {
        io.unobserve(el);
        watched.delete(el);
        const id = (el as HTMLElement).dataset.widgetId;
        if (id !== undefined) endDwell(id);
      }
    for (const el of live)
      if (!watched.has(el)) {
        watched.add(el);
        io.observe(el);
      }
  };

  let lastBlueprint: string | undefined;
  const setView = (): void => {
    const bp = root.dataset.blueprintId;
    if (bp === undefined || bp === lastBlueprint) return;
    lastBlueprint = bp;
    const { experienceId, versionHash } = parseBlueprintId(bp);
    // a new version: what was visible belongs to the old view, and what still is must be exposed
    // again in the new one — a fresh observe makes the observer report it
    for (const id of [...since.keys()]) endDwell(id);
    for (const el of watched) io?.unobserve(el);
    watched.clear();
    collector.setView(
      { experienceId, versionHash, ...(opts.compile !== undefined && { compile: opts.compile }) },
      placeholders
    );
  };

  const onClick = (e: Event): void => {
    const id = idOf(e.target as Element | null);
    if (id !== undefined) collector.engage(id, "click");
  };
  const onToggle = (e: Event): void => {
    const t = e.target as HTMLDetailsElement | null;
    if (t?.tagName !== "DETAILS" || t.open !== true) return;
    const id = idOf(t);
    if (id !== undefined) collector.engage(id, "expand");
  };
  const onHide = (): void => {
    if (!hidden()) return;
    for (const id of [...since.keys()]) endDwell(id);
    if (opts.flushOnHide !== false) void collector.flush();
  };

  root.addEventListener("click", onClick, true);
  root.addEventListener("toggle", onToggle, true);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHide);
  setView();
  scan();

  return {
    refresh() {
      if (disposed) return;
      setView();
      scan();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...since.keys()]) endDwell(id);
      io?.disconnect();
      watched.clear();
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("toggle", onToggle, true);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onHide);
    },
  };
}
