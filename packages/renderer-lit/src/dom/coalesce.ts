import type { Blueprint } from "@loom/blueprint-runtime";
import type { RecomposeReport } from "./registry";
import type { DomRenderHandle } from "./renderBlueprintDom";

// ── Update coalescing (U17) ───────────────────────────────────────────────────────────────────
// `DomRenderHandle.update` is synchronous and walks the whole tree, so an agent that revises the
// Blueprint ten times in a frame costs ten reconciles of which nine are never painted. A
// `FrameScheduler` says WHEN pending work should run; `coalesceUpdates` keeps only the NEWEST
// Blueprint and lands it once. A superseded Blueprint is never rendered, which is safe because
// `update` is defined by the LAST committed tree and the new one, not by the path between them.

/** Run `run` once at the next opportunity; the returned function cancels it if it has not run. */
export type FrameScheduler = (run: () => void) => () => void;

/** The longest a pending update waits when animation frames are paused (a background tab). */
export const FRAME_FALLBACK_MS = 250;

/**
 * The default scheduler: the next animation frame, or a short deadline if no frame comes (a hidden
 * tab pauses `requestAnimationFrame`, and a pending update must still land), or a macrotask where
 * there is no `requestAnimationFrame` at all.
 */
export const animationFrameScheduler: FrameScheduler = (run) => {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    cancel();
    run();
  };
  let raf: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof requestAnimationFrame === "function") {
    raf = requestAnimationFrame(once);
    timer = setTimeout(once, FRAME_FALLBACK_MS);
  } else timer = setTimeout(once, 0);
  function cancel(): void {
    done = true;
    if (raf !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    if (timer !== undefined) clearTimeout(timer);
  }
  return cancel;
};

export interface CoalescedUpdates {
  /**
   * Queue `next` as the Blueprint to show. Resolves with the report of the pass that actually landed
   * (the same report for every call it absorbed). A call superseded by a newer one before the frame
   * resolves with THAT newer pass's report. Resolves `undefined` if the scheduler was disposed first.
   */
  update(next: Blueprint): Promise<RecomposeReport | undefined>;
  /** Land the pending Blueprint now (a no-op returning `undefined` when nothing is pending). */
  flush(): RecomposeReport | undefined;
  /** Whether a Blueprint is waiting for its frame. */
  readonly pending: boolean;
  /** Drop the pending update without rendering it. Idempotent. Does NOT dispose the handle. */
  dispose(): void;
}

export interface CoalesceOptions {
  /** When to land the pending Blueprint. Default {@link animationFrameScheduler}. */
  readonly schedule?: FrameScheduler;
}

/**
 * Wrap a render handle so that any number of `update` calls between two frames cost ONE reconcile
 * of the newest Blueprint. The handle itself is untouched: call `handle.update` directly to bypass.
 */
export function coalesceUpdates(
  handle: Pick<DomRenderHandle, "update">,
  opts: CoalesceOptions = {}
): CoalescedUpdates {
  const schedule = opts.schedule ?? animationFrameScheduler;
  let latest: Blueprint | undefined;
  let cancel: (() => void) | undefined;
  let waiters: Array<(r: RecomposeReport | undefined) => void> = [];
  let disposed = false;
  let scheduled = false;

  const land = (): RecomposeReport | undefined => {
    cancel?.();
    cancel = undefined;
    scheduled = false;
    const next = latest;
    const toWake = waiters;
    latest = undefined;
    waiters = [];
    if (next === undefined) return undefined;
    let report: RecomposeReport | undefined;
    try {
      report = handle.update(next);
    } finally {
      for (const w of toWake) w(report);
    }
    return report;
  };

  return {
    update: (next) => {
      if (disposed) return Promise.resolve(undefined);
      latest = next;
      const done = new Promise<RecomposeReport | undefined>((resolve) => waiters.push(resolve));
      if (!scheduled) {
        scheduled = true;
        const c = schedule(() => {
          if (!scheduled) return;
          land();
        });
        // A scheduler may run synchronously: only keep the canceller if it has not landed yet.
        if (scheduled) cancel = c;
      }
      return done;
    },
    flush: land,
    get pending() {
      return latest !== undefined;
    },
    dispose: () => {
      disposed = true;
      scheduled = false;
      cancel?.();
      cancel = undefined;
      latest = undefined;
      const toWake = waiters;
      waiters = [];
      for (const w of toWake) w(undefined);
    },
  };
}
