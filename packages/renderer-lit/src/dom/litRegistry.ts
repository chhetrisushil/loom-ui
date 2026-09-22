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
];

export const litRegistry: DomRegistry = new RendererRegistry<DomWidgetRenderer>()
  .register("MetricCard", elementRenderer("lu-metric-card"))
  .register("StatusBadge", elementRenderer("lu-status-badge"))
  .register("DataTable", elementRenderer("lu-data-table"))
  .register("TimeSeries", elementRenderer("lu-timeseries"))
  .register("BarChart", elementRenderer("lu-bar-chart"))
  .register("ProgressBar", elementRenderer("lu-progress"))
  .register("AlertCard", elementRenderer("lu-alert"))
  .register("StreamingText", elementRenderer("lu-text"))
  .register("Timeline", elementRenderer("lu-list"))
  .register("ApprovalCard", elementRenderer("lu-approval"));
