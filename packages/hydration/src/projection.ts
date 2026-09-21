import type { Finding } from "@loom-ui/core";
import type { EventEnvelope } from "@loom/core";
import type { Projection, ProjectionRuntime } from "@loom/projection-runtime";

// ── One projection, keyed by handle ───────────────────────────────────────────
// Compiled widgets bind to `values.<handle>` (core's `hydrationPath`), and the compiler pins
// HYDRATION_PROJECTION_VERSION into the blueprint (ADR 0095). Hydration is imperative and
// transient — nothing here is durable or replayed — so the projection is driven by ONE synthetic
// in-memory event type. `subscribeSelector` gives each handle its own slice, so a value resolving
// wakes one widget, not the surface.

export const HYDRATION_PROJECTION_ID = "loom-ui.hydration";
/** Bump when the MEANING of `values`/`status` changes; the compiler pins this into every blueprint. */
export const HYDRATION_PROJECTION_VERSION = "1.0.0";
export const HYDRATION_SET_EVENT = "LOOM_UI_HYDRATION_SET";

export type HandleState = "pending" | "ready" | "stale" | "error";
export interface HandleStatus {
  readonly state: HandleState;
  readonly seq: number;
  readonly finding?: Finding;
}
export interface HydrationState {
  readonly values: Record<string, unknown>;
  readonly status: Record<string, HandleStatus>;
}

type SetPayload =
  | { kind: "status"; handle: string; status: HandleStatus }
  | { kind: "value"; handle: string; value: unknown; status: HandleStatus }
  | { kind: "remove"; handle: string };

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(handle);
}

// `Object.fromEntries` uses CreateDataProperty for each entry, so a `__proto__` key lands as
// an own property — never the prototype setter that a plain `out[k] = v` assignment would hit.
function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
}

export function hydrationProjection(): Projection<HydrationState> {
  return {
    id: HYDRATION_PROJECTION_ID,
    version: HYDRATION_PROJECTION_VERSION,
    initialState: { values: {}, status: {} },
    handlers: {
      [HYDRATION_SET_EVENT]: (state, event) => {
        const p = event.payload as SetPayload;
        // Defense in depth: `HydrationStore` already refuses reserved handles before emitting,
        // but this projection is registered on a SHARED runtime — any other holder of that
        // runtime can call `handleEvent` directly with a forged envelope, bypassing the store.
        // The fold itself must never write a reserved handle into state.
        if (isReservedHandle(p.handle)) return state;
        if (p.kind === "remove") {
          if (!Object.hasOwn(state.status, p.handle) && !Object.hasOwn(state.values, p.handle))
            return state;
          return {
            values: without(state.values, p.handle),
            status: without(state.status, p.handle),
          };
        }
        const status = { ...state.status, [p.handle]: p.status };
        if (p.kind === "status") return { values: state.values, status };
        return { values: { ...state.values, [p.handle]: p.value }, status };
      },
    },
  };
}

export interface HandleSlice {
  readonly value: unknown;
  readonly status: HandleStatus | undefined;
}

/**
 * What a store's state belongs to. Isolation is by (experience, principal); two viewers of one
 * experience must not share a store — `values` holds whatever the viewer's own principal chain
 * was allowed to read, so a shared store is a cross-viewer data leak, not a cache win.
 * Omit `principalId` only where there is genuinely one viewer (a single-user CLI, a test).
 */
export interface HydrationScope {
  readonly experienceId: string;
  readonly principalId?: string;
}

export class HydrationStore {
  private seq = 0; // status seq — monotone per store
  private emitSeq = 0; // envelope sequence — every emit, including remove
  /** The projection state key: the scope, flattened. Derived — never passed in. */
  readonly executionId: string;

  /**
   * Isolation is by (experience, principal); two viewers of one experience must not share a
   * store. The projection is keyed by `executionId`, so a per-viewer store is what keeps one
   * viewer's values out of another's widgets even on a SHARED `ProjectionRuntime`.
   */
  constructor(
    private readonly runtime: ProjectionRuntime,
    readonly scope: HydrationScope,
    opts: { register?: boolean } = {}
  ) {
    this.executionId =
      scope.principalId === undefined
        ? scope.experienceId
        : `${scope.experienceId}:${scope.principalId}`;
    if (opts.register !== false) runtime.register(hydrationProjection());
  }

  state(): HydrationState {
    return this.runtime.getState<HydrationState>(HYDRATION_PROJECTION_ID, this.executionId);
  }
  status(handle: string): HandleStatus | undefined {
    const s = this.state().status;
    return Object.hasOwn(s, handle) ? s[handle] : undefined;
  }
  value(handle: string): unknown {
    const v = this.state().values;
    return Object.hasOwn(v, handle) ? v[handle] : undefined;
  }
  handles(): string[] {
    return Object.keys(this.state().status);
  }

  setStatus(handle: string, status: Omit<HandleStatus, "seq">): void {
    this.assertValidHandle(handle);
    this.emit({ kind: "status", handle, status: this.stamp(status) });
  }
  setValue(handle: string, value: unknown, status: Omit<HandleStatus, "seq">): void {
    this.assertValidHandle(handle);
    this.emit({ kind: "value", handle, value, status: this.stamp(status) });
  }
  remove(handle: string): void {
    this.assertValidHandle(handle);
    this.emit({ kind: "remove", handle });
  }

  /** Whole-state subscription: fires on ANY handle's value or status change. For a surface that renders the full projection (e.g. a terminal `watch` loop) rather than one widget's slice. */
  runtimeSubscribe(listener: (state: HydrationState) => void): () => void {
    return this.runtime.subscribe<HydrationState>(
      HYDRATION_PROJECTION_ID,
      this.executionId,
      listener
    );
  }

  /** Slice-scoped: fires only when THIS handle's status seq or value changes. Change-only, like loom's subscribe. */
  subscribe(handle: string, listener: (slice: HandleSlice) => void): () => void {
    return this.runtime.subscribeSelector<HydrationState, HandleSlice>(
      HYDRATION_PROJECTION_ID,
      this.executionId,
      (s) => ({
        value: Object.hasOwn(s.values, handle) ? s.values[handle] : undefined,
        status: Object.hasOwn(s.status, handle) ? s.status[handle] : undefined,
      }),
      listener,
      (a, b) => a.status?.seq === b.status?.seq && a.value === b.value
    );
  }

  private assertValidHandle(handle: string): void {
    if (isReservedHandle(handle)) throw new Error(`handle "${handle}" is reserved`);
  }

  private stamp(status: Omit<HandleStatus, "seq">): HandleStatus {
    this.seq += 1;
    return { ...status, seq: this.seq };
  }

  private emit(payload: SetPayload): void {
    this.emitSeq += 1;
    const envelope: EventEnvelope = {
      id: `loom-ui-hydration-${this.executionId}-${this.emitSeq}`,
      workflowId: "loom-ui.hydration",
      executionId: this.executionId,
      eventType: HYDRATION_SET_EVENT,
      sequence: this.emitSeq,
      timestamp: 0, // transient; never persisted, never compared
      payload,
    };
    this.runtime.handleEvent(envelope);
  }
}
