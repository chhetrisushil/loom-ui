import { FRAMEWORK_KINDS } from "@loom-ui/core";
import { type BindingStatus, type CatalogEntry, RendererRegistry } from "@loom/blueprint-runtime";
import "../widgets/index";
import type { DomRegistry, DomWidgetRenderer } from "./registry";

/** A renderer that mounts `<tag>` and drives its `widget/value/status/onAction` properties. */
export function elementRenderer(tag: string): DomWidgetRenderer {
  return (host, props) => {
    const el = document.createElement(tag) as HTMLElement & {
      widget: unknown;
      value: unknown;
      status: BindingStatus | undefined;
      onAction: unknown;
    };
    el.widget = props.widget;
    el.value = props.value;
    el.status = props.status;
    el.onAction = props.onAction;
    host.appendChild(el);
    return {
      update: (value, status) => {
        el.value = value;
        el.status = status;
      },
      patch: (widget) => {
        el.widget = widget;
      },
      dispose: () => el.remove(),
    };
  };
}

export const LIT_ONLY_KINDS: ReadonlySet<string> = new Set(FRAMEWORK_KINDS);

/** The loom contract an app declares on a semantic entry's `surfaces.web` when it resolves to a
 * framework kind. */
export const frameworkKindContracts: readonly CatalogEntry[] = [
  { kind: "TimeSeries", props: ["unit", "format"], binding: "required" },
  { kind: "BarChart", props: ["unit", "format"], binding: "required" },
  { kind: "Kpi", props: ["unit", "format"], binding: "required" },
  { kind: "Table", props: [], binding: "required" },
  { kind: "StatusCard", props: [], binding: "required" },
  // Static text; declare `textProps: ["text"]` on the semantic entry to localize it at compile.
  { kind: "Note", props: ["text"], binding: "none" },
  // The declarative component tree / the untrusted render code ride as declared props; the
  // bound value is their data.
  { kind: "A2UIView", props: ["view"], binding: "required" },
  { kind: "SandboxView", props: ["code"], binding: "required" },
];

export const litRegistry: DomRegistry = new RendererRegistry<DomWidgetRenderer>()
  .register("MetricCard", elementRenderer("lu-metric-card"))
  .register("StatusBadge", elementRenderer("lu-status-badge"))
  .register("DataTable", elementRenderer("lu-data-table"))
  .register("TimeSeries", elementRenderer("lu-timeseries"))
  .register("BarChart", elementRenderer("lu-bar-chart"))
  .register("Kpi", elementRenderer("lu-kpi"))
  .register("Table", elementRenderer("lu-table"))
  .register("StatusCard", elementRenderer("lu-status-card"))
  .register("Note", elementRenderer("lu-note"))
  .register("A2UIView", elementRenderer("lu-a2ui-widget"))
  .register("SandboxView", elementRenderer("lu-sandbox-widget"))
  .register("ProgressBar", elementRenderer("lu-progress"))
  .register("AlertCard", elementRenderer("lu-alert"))
  .register("StreamingText", elementRenderer("lu-text"))
  .register("Timeline", elementRenderer("lu-list"))
  .register("ApprovalCard", elementRenderer("lu-approval"));
