import type { Widget } from "@loom/blueprint-runtime";

// ── Visibility reporting (U17) ────────────────────────────────────────────────────────────────
// Hydration's P2 handles are fetched when the surface says they are on screen
// (`HydrationController.markVisible(handle)` / `SplitHydrationController.markVisible`). Nothing in the
// renderer called it, so a P2 handle stayed `loading` unless the host wrote its own observer. This is
// that observer, once: ONE shared `IntersectionObserver` per rendered tree watches the host element of
// every BOUND widget and tells the host (`DomRenderOptions.onVisible`) when one scrolls into view.
//
// The renderer stays free of hydration: it reports the WIDGET, and the host maps its binding to a
// handle (`handleOfPath(widget.binding.path)` from `@loom-ui/hydration/client`) and calls
// `markVisible`. `markVisible` is idempotent per question, so reporting every entry into view (not
// just the first) is right: a handle whose question changed waits for its NEXT `markVisible`.
//
// No `IntersectionObserver` (an old browser, a server render, a test DOM without one) fails OPEN: the
// widget is reported as visible at once, because a P2 handle that never loads is worse than one that
// loads early.

export interface VisibilityOptions {
  /** Called when a bound widget enters the viewport (and again on each later re-entry). Never throws into the renderer. */
  readonly onVisible: (widget: Widget) => void;
  /** `IntersectionObserver`'s `rootMargin`: how far outside the viewport counts as visible. Default `"100px"`. */
  readonly rootMargin?: string;
}

/** What a widget entry holds to stay observed. */
export interface Observed {
  /** Stop observing (idempotent): on dispose, remount, or when the widget unmounts. */
  stop(): void;
  /** The widget's binding changed: report it again if it is on screen now (its question is new). */
  rebound(): void;
}

export interface VisibilityTracker {
  observe(host: HTMLElement, widget: () => Widget): Observed;
  /** Disconnect the shared observer and drop everything it watched. */
  disconnect(): void;
}

export function createVisibilityTracker(opts: VisibilityOptions): VisibilityTracker {
  const report = (widget: Widget): void => {
    try {
      opts.onVisible(widget);
    } catch {
      // A host callback must never break a render or an observer delivery.
    }
  };
  interface State {
    widget: () => Widget;
    visible: boolean;
  }
  const watched = new Map<Element, State>();
  const IO = typeof IntersectionObserver === "function" ? IntersectionObserver : undefined;
  const io = IO
    ? new IO(
        (entries) => {
          for (const e of entries) {
            const s = watched.get(e.target);
            if (s === undefined) continue;
            if (e.isIntersecting && !s.visible) {
              s.visible = true;
              report(s.widget());
            } else if (!e.isIntersecting) s.visible = false;
          }
        },
        { rootMargin: opts.rootMargin ?? "100px" }
      )
    : undefined;

  return {
    observe: (host, widget) => {
      const state: State = { widget, visible: false };
      if (io === undefined) {
        // Fail open: no way to know, so say it is visible.
        report(widget());
        return { stop: () => {}, rebound: () => report(widget()) };
      }
      watched.set(host, state);
      io.observe(host);
      return {
        stop: () => {
          if (watched.get(host) !== state) return;
          watched.delete(host);
          io.unobserve(host);
        },
        rebound: () => {
          if (watched.get(host) === state && state.visible) report(widget());
        },
      };
    },
    disconnect: () => {
      io?.disconnect();
      watched.clear();
    },
  };
}
