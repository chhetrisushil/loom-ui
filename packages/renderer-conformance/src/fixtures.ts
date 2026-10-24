import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID } from "@loom-ui/hydration/client";
import {
  type Blueprint,
  type DataBinding,
  type Layout,
  type Widget,
  blueprint$,
  customWidget$,
  flex,
  stack,
} from "@loom/blueprint-runtime";

/** A hydration binding with its status channel, exactly as `compile` emits it. */
export const bind = (handle: string): DataBinding => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
  status: { path: hydrationStatusPath(handle) },
});

/** A bound widget of any kind (loom built-in or framework). `props` are the kind's declared props. */
export const bound = (
  kind: string,
  id: string,
  title: string,
  handle: string,
  props: Record<string, unknown> = {}
): Widget => customWidget$({ kind, id, title, binding: bind(handle), props });

/** A widget with no binding (a `Note`, an input). */
export const unbound = (
  kind: string,
  id: string,
  title: string | undefined,
  props: Record<string, unknown> = {}
): Widget => customWidget$({ kind, id, ...(title === undefined ? {} : { title }), props });

export const viewOf = (children: Array<Widget | Layout>, title = "Conformance"): Blueprint =>
  blueprint$({
    id: "conformance@v1",
    title,
    projections: [HYDRATION_PROJECTION_ID],
    layout: stack({ children }),
  });

/** A container with a role (`tabs`, `stepper`…) and a title. */
export const roleLayout = (role: string, title: string, children: Widget[]): Layout =>
  flex({ direction: "column", role, title, children });

/** One fixture per kind the kit knows: its value and what a viewer must be able to READ of it. */
export interface KindFixture {
  readonly kind: string;
  readonly title: string;
  readonly props?: Record<string, unknown>;
  /** Absent = a static kind (no binding). */
  readonly value?: unknown;
  /** Substrings the surface must carry once the value is delivered. */
  readonly needles: readonly string[];
}

export const KIND_FIXTURES: readonly KindFixture[] = [
  { kind: "MetricCard", title: "Orders metric", value: 4.5, needles: ["4.5"] },
  { kind: "StatusBadge", title: "Phase badge", value: "triaging", needles: ["triaging"] },
  { kind: "Kpi", title: "Throughput kpi", value: { value: 4.5 }, needles: ["4.5"] },
  {
    kind: "Table",
    title: "Top tables",
    value: { columns: ["db", "p99"], rows: [["orders-db", 12]] },
    needles: ["orders-db"],
  },
  {
    kind: "StatusCard",
    title: "Replication card",
    value: { level: "warning", headline: "Replica lag", detail: "12s behind" },
    needles: ["Replica lag"],
  },
  {
    kind: "BarChart",
    title: "Bars chart",
    value: { bars: [{ label: "alpha-bar", value: 3 }] },
    needles: ["alpha-bar"],
  },
  {
    kind: "TimeSeries",
    title: "Latency series",
    value: {
      series: [
        {
          label: "p99-series",
          points: [
            { timestamp: "2026-01-01T00:00:00Z", value: 1 },
            { timestamp: "2026-01-01T00:01:00Z", value: 4 },
          ],
        },
      ],
    },
    needles: ["p99-series"],
  },
  {
    kind: "Prose",
    title: "Prose doc",
    value: { format: "markdown", text: "# Heading\n\nbody" },
    needles: ["Heading", "body"],
  },
  {
    kind: "Note",
    title: "About note",
    props: { text: "Plain words 77" },
    needles: ["Plain words 77"],
  },
];

/** The marks that mean a renderer printed an unformatted JS value. */
export const GARBAGE = ["[object Object]", "undefined", "NaN", "null"] as const;
