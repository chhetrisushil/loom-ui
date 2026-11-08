// ── Source references on a data widget ──────────────────────────────────────────────────────────
// A `Kpi`, `BarChart`, `TimeSeries`, `Table`, `StatusCard` or `Diagram` VALUE may carry `refs`: the sources the
// widget's data came from, as `{ id, label? }`. A renderer draws numbered markers (1, 2, ...) in array order;
// activating one emits `REF_OPEN { refId, n }` through the widget's action channel and the HOST decides what
// "open" means. The refs are widget-level only (never per row or per point) and value-level only (hydrated
// data, never planner props). Zod-free and DOM-free: the zod contracts (`values.ts`) and the browser checker
// (`kindValues.ts`) both call `widgetRefProblems`, so the two cannot disagree on a rule or on its words.

/** The action type a source marker emits: `payload: { refId, n }`, `n` the 1-based position in `refs`. */
export const REF_OPEN_ACTION = "REF_OPEN";
export const MAX_WIDGET_REFS = 16;
export const MAX_WIDGET_REF_LABEL = 200;

/** The framework kinds whose value may carry `refs`. */
export const WIDGET_REF_KINDS: readonly string[] = [
  "Kpi",
  "BarChart",
  "TimeSeries",
  "Table",
  "StatusCard",
  "Diagram",
];

// Chat's ref id rule (`chatRefs.ts` MARKER): a short identifier.
const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** One source a widget cites. */
export interface WidgetRef {
  readonly id: string;
  readonly label?: string;
}

export interface WidgetRefProblem {
  readonly path: (string | number)[];
  readonly message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why `refs` is not a valid source list; empty when it is. Paths are relative to `refs`. Total on any
 * input (a wrong type is the structural check's to report, so it is skipped here); messages never echo a value.
 */
export function widgetRefProblems(refs: unknown): WidgetRefProblem[] {
  const out: WidgetRefProblem[] = [];
  if (!Array.isArray(refs)) return out;
  if (refs.length > MAX_WIDGET_REFS) {
    out.push({ path: [], message: `at most ${MAX_WIDGET_REFS} refs` });
    return out;
  }
  const seen = new Set<string>();
  refs.forEach((r, i) => {
    if (!isRecord(r)) return;
    const { id, label } = r;
    if (typeof id === "string") {
      if (!REF_ID.test(id)) out.push({ path: [i], message: "a ref id must be a short identifier" });
      else if (seen.has(id)) out.push({ path: [i], message: "ref ids must be unique" });
      else seen.add(id);
    }
    if (typeof label === "string" && label.length > MAX_WIDGET_REF_LABEL)
      out.push({
        path: [i],
        message: `a ref label is at most ${MAX_WIDGET_REF_LABEL} characters`,
      });
  });
  return out;
}

/** The refs a value carries, or none: for a renderer that has already passed the value's contract. */
export function widgetRefsOf(kind: string, value: unknown): readonly WidgetRef[] {
  if (!WIDGET_REF_KINDS.includes(kind) || !isRecord(value)) return [];
  const refs = value.refs;
  return Array.isArray(refs) ? (refs as WidgetRef[]) : [];
}
