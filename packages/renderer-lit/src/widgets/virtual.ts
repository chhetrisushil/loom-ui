import {
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
  html,
} from "lit";

// ── Windowed rendering for large row sets (U17) ───────────────────────────────────────────────
// `lu-table` / `lu-data-table` used to cap the DOM at 200 rows behind a "show more" button, which is
// the right default for small data and the wrong one for a 50,000-row result a user wants to scroll.
// With `virtualize` on, only the rows near the scroll position are in the DOM; two spacer rows keep
// the scrollbar and the sticky header honest. Off (the default), nothing here runs and the widgets
// render exactly as before.
//
// The host app turns it on once, for every widget the registry mounts:
//
//   createLitRegistry({ virtualize: true })                      // defaults
//   createLitRegistry({ virtualize: { rowHeight: 36, overscan: 12, minRows: 500 } })
//
// ROWS ARE A FIXED HEIGHT while windowed (cells are single-line already: `white-space: nowrap`). That
// is what makes the window a pure function of `scrollTop`, with no measuring pass.

/** The windowing knobs. Every field is optional. */
export interface VirtualizeOptions {
  /** One row's height in px while windowed. Default {@link DEFAULT_ROW_HEIGHT}. */
  readonly rowHeight?: number;
  /** Rows kept mounted beyond each edge of the viewport. Default {@link DEFAULT_OVERSCAN}. */
  readonly overscan?: number;
  /** Windowing starts above this many rows; at or below it the classic rendering is used. Default {@link DEFAULT_MIN_ROWS}. */
  readonly minRows?: number;
}

export const DEFAULT_ROW_HEIGHT = 30;
export const DEFAULT_OVERSCAN = 8;
export const DEFAULT_MIN_ROWS = 200;
/** The viewport height assumed when the host has no layout yet (`clientHeight` 0): a first paint, a test DOM. */
export const FALLBACK_VIEWPORT = 480;

export interface ResolvedVirtualize {
  readonly rowHeight: number;
  readonly overscan: number;
  readonly minRows: number;
}

const positive = (n: unknown, fallback: number, min: number): number =>
  typeof n === "number" && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;

/** `undefined`/`false` -> off; `true` -> defaults; an object -> its knobs, each clamped to something sane. */
export function resolveVirtualize(
  v: boolean | VirtualizeOptions | undefined
): ResolvedVirtualize | undefined {
  if (v === undefined || v === false) return undefined;
  const o = v === true ? {} : v;
  return {
    rowHeight: positive(o.rowHeight, DEFAULT_ROW_HEIGHT, 1),
    overscan: positive(o.overscan, DEFAULT_OVERSCAN, 0),
    minRows: positive(o.minRows, DEFAULT_MIN_ROWS, 0),
  };
}

export interface RowWindow {
  /** First mounted row (inclusive). */
  readonly start: number;
  /** One past the last mounted row. */
  readonly end: number;
  /** Height of the spacer above / below the mounted rows. */
  readonly padTop: number;
  readonly padBottom: number;
}

/**
 * The rows to mount for a scroll position: those intersecting `[scrollTop, scrollTop + viewport)`
 * plus `overscan` on each side. Pure; `scrollTop` past either end is clamped, never a blank window.
 */
export function virtualWindow(
  total: number,
  rowHeight: number,
  scrollTop: number,
  viewport: number,
  overscan: number
): RowWindow {
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const maxTop = Math.max(0, total * rowHeight - viewport);
  const top = Math.min(Math.max(0, scrollTop), maxTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + viewport) / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, Math.max(start + 1, last + overscan));
  return { start, end, padTop: start * rowHeight, padBottom: (total - end) * rowHeight };
}

/**
 * Tracks the host's scroll position and asks it to re-render ONLY when the mounted window changes
 * (a scroll of a few pixels inside the same window costs nothing). The host element is the scroller; if it proves not to be, `plan` returns `undefined` (classic rendering).
 */
export class VirtualRows implements ReactiveController {
  private lastStart = -1;
  private lastEnd = -1;
  private total = 0;
  private cfg: ResolvedVirtualize | undefined;
  /** The row count at which the host proved NOT to be a scroll container (see {@link hostUpdated}); -1 = not degraded. */
  private degradedAt = -1;

  constructor(private readonly host: ReactiveControllerHost & HTMLElement) {
    host.addController(this);
  }

  hostConnected(): void {
    this.host.addEventListener("scroll", this.onScroll, { passive: true });
  }
  hostDisconnected(): void {
    this.host.removeEventListener("scroll", this.onScroll);
  }

  /**
   * A window is only a pure function of the HOST's `scrollTop`, which holds only if the host is the
   * scroll container. When it is not (the page scrolls, the host has no definite height, or it has no
   * layout box at all), no `scroll` event ever reaches it and the rows past the first window would
   * stay blank for ever. After a windowed render the spacers make the content taller than the host
   * if and only if the host clips it, so `scrollHeight <= clientHeight` (or no height) means "not a
   * scroller": fall back to the classic full rendering for this row count.
   */
  hostUpdated(): void {
    if (this.lastStart < 0) return; // not windowed on this render
    if (this.host.clientHeight > 0 && this.host.scrollHeight > this.host.clientHeight) return;
    this.degradedAt = this.total;
    this.lastStart = this.lastEnd = -1;
    this.host.requestUpdate();
  }

  private viewport(): number {
    return this.host.clientHeight > 0 ? this.host.clientHeight : FALLBACK_VIEWPORT;
  }

  private onScroll = (): void => {
    if (this.cfg === undefined) return;
    const w = virtualWindow(
      this.total,
      this.cfg.rowHeight,
      this.host.scrollTop,
      this.viewport(),
      this.cfg.overscan
    );
    if (w.start !== this.lastStart || w.end !== this.lastEnd) this.host.requestUpdate();
  };

  /** The window to render now; remembers it so `onScroll` can tell when it has changed. `undefined` = classic rendering. */
  plan(total: number, cfg: ResolvedVirtualize | undefined): RowWindow | undefined {
    this.cfg = cfg;
    this.total = total;
    if (cfg === undefined || total <= cfg.minRows) {
      this.lastStart = this.lastEnd = -1;
      this.degradedAt = -1;
      return undefined;
    }
    if (this.degradedAt === total) {
      this.lastStart = this.lastEnd = -1;
      return undefined; // the host is not a scroller: classic rendering
    }
    this.degradedAt = -1;
    const w = virtualWindow(
      total,
      cfg.rowHeight,
      this.host.scrollTop,
      this.viewport(),
      cfg.overscan
    );
    this.lastStart = w.start;
    this.lastEnd = w.end;
    return w;
  }

  /** Back to the top (a new sort): the old offset means nothing for the new order. */
  reset(): void {
    this.host.scrollTop = 0;
  }
}

/** A spacer row standing in for the rows that are not mounted. Hidden from assistive tech. */
export function padRow(height: number, columns: number): TemplateResult | undefined {
  if (height <= 0) return undefined;
  return html`<tr class="pad" aria-hidden="true" style="height:${height}px"><td colspan=${columns} style="padding:0;border:0;height:${height}px"></td></tr>`;
}
