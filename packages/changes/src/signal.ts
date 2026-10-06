import type { HeadChange, HeadSignal } from "@loom-ui/core";
import { type LineageStore, foldLineage } from "@loom-ui/lineage";
import { LINEAGE_STREAM_PREFIX } from "@loom-ui/lineage";
import type { EventStore } from "@loom/event-runtime";

// ── Head signals: how a reader learns "this experience moved" ─────────────────
// Two implementations of core's `HeadSignal`, sharing one check: read the line, and if its tip is
// past what this watcher last reported, report `{ sequence, head, promoted }`. They differ only in
// WHAT TRIGGERS the check.
//
//   pollingHeadSignal       a timer. Works over ANY `LineageStore`; costs one read per interval
//                           per watcher. The default; a missed beat is only latency.
//   eventStoreHeadSignal    a subscription to the line's stream on loom's `EventStore`
//                           (`EventStore.subscribe`): the check runs when an event lands. A push
//                           adapter for the store the lineage already writes to.
//
// loom's `@loom/live-query` was checked and does NOT fit: it folds an EXECUTION's `ExecutionState`
// (`loadState`), and a lineage stream is a reserved stream of lineage events, not an execution.
// `EventStore.subscribe` is the push primitive underneath it, used here directly. A host with its
// own transport (a websocket, SSE, a database notify) implements `HeadSignal` (one method).

export interface SignalOptions {
  /** A read or fold that failed. The watcher keeps going: the next trigger tries again. */
  readonly onError?: (err: unknown) => void;
}

/** One watcher's check: at most one read in flight, reports each new tip once. */
function checker(
  store: LineageStore,
  experienceId: string,
  onChange: (c: HeadChange) => void,
  onError: ((e: unknown) => void) | undefined
): { check: () => Promise<void>; stop: () => void } {
  let seen = 0;
  let stopped = false;
  let busy = false;
  let rerun = false;
  const fail = (e: unknown) => {
    try {
      onError?.(e);
    } catch {
      // never break the signal
    }
  };
  const check = async (): Promise<void> => {
    if (busy) {
      rerun = true;
      return;
    }
    busy = true;
    try {
      do {
        rerun = false;
        const records = await store.read(experienceId);
        if (stopped || records.length <= seen) continue;
        seen = records.length;
        const fold = foldLineage(experienceId, records);
        if (!fold.ok) {
          fail(fold.finding);
          continue;
        }
        try {
          onChange({
            experienceId,
            sequence: fold.state.sequence,
            head: fold.state.head,
            promoted: fold.state.promoted,
          });
        } catch (e) {
          fail(e);
        }
      } while (rerun && !stopped);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  };
  return {
    check,
    stop: () => {
      stopped = true;
    },
  };
}

export interface PollingOptions extends SignalOptions {
  /** Milliseconds between checks (default 2000; floor 10). */
  readonly intervalMs?: number;
  /** Injectable timer: run `fn` every `ms`, return a canceller. Default `setInterval` (unref'd). */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
};

export function pollingHeadSignal(store: LineageStore, opts: PollingOptions = {}): HeadSignal {
  const intervalMs = Math.max(
    10,
    Number.isFinite(opts.intervalMs) ? (opts.intervalMs as number) : 2000
  );
  const schedule = opts.schedule ?? defaultSchedule;
  return {
    watch(experienceId, onChange) {
      const c = checker(store, experienceId, onChange, opts.onError);
      void c.check();
      const cancel = schedule(() => void c.check(), intervalMs);
      return () => {
        c.stop();
        cancel();
      };
    },
  };
}

export function eventStoreHeadSignal(
  events: EventStore,
  store: LineageStore,
  opts: SignalOptions = {}
): HeadSignal {
  return {
    watch(experienceId, onChange) {
      const c = checker(store, experienceId, onChange, opts.onError);
      let off: (() => void) | undefined;
      let stopped = false;
      events
        .subscribe(`${LINEAGE_STREAM_PREFIX}${experienceId}`, () => void c.check())
        .then((u) => {
          if (stopped) u();
          else off = u;
        })
        .catch((e) => opts.onError?.(e));
      void c.check();
      return () => {
        stopped = true;
        c.stop();
        off?.();
      };
    },
  };
}
