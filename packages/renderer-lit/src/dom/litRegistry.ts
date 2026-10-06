import { type ContractRegistry, FRAMEWORK_KINDS } from "@loom-ui/core/browser";
import { type BindingStatus, type CatalogEntry, RendererRegistry } from "@loom/blueprint-runtime";
import "../widgets/index";
import type { TitleChrome } from "../widgets/base";
import type { DomRegistry, DomWidgetRenderer } from "./registry";

/** A renderer that mounts `<tag>` and drives its `widget/value/status/onAction` properties. */
export function elementRenderer(tag: string, opts: LitRegistryOptions = {}): DomWidgetRenderer {
  const chrome = opts.chrome;
  const contracts = opts.contracts;
  return (host, props) => {
    const el = document.createElement(tag) as HTMLElement & {
      widget: unknown;
      value: unknown;
      status: BindingStatus | undefined;
      onAction: unknown;
      chrome: TitleChrome;
      contracts?: ContractRegistry;
    };
    if (chrome !== undefined) el.chrome = chrome;
    if (contracts !== undefined) el.contracts = contracts;
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

/** Options shared by every widget the registry mounts. */
export interface LitRegistryOptions {
  /**
   * Who draws each widget's title: `"widget"` (default — today's behaviour) or `"host"`, for an
   * app that draws its own title bar or frame and wants the body without a second title. The
   * accessible name still carries the title. Also settable per element (`el.chrome = "host"`).
   */
  readonly chrome?: TitleChrome;
  /**
   * The catalogue's `valueContracts`: a widget of a host kind (one you registered a Lit element
   * for) checks its bound value against these. Without a contract for it, the widget renders
   * with `data-unchecked` rather than silently passing.
   */
  readonly contracts?: ContractRegistry;
}

/** The widget registry, configured. A NEW registry each call; `litRegistry` is `createLitRegistry()`. */
export function createLitRegistry(opts: LitRegistryOptions = {}): DomRegistry {
  const el = (tag: string): DomWidgetRenderer => elementRenderer(tag, opts);
  return new RendererRegistry<DomWidgetRenderer>()
    .register("MetricCard", el("lu-metric-card"))
    .register("StatusBadge", el("lu-status-badge"))
    .register("DataTable", el("lu-data-table"))
    .register("TimeSeries", el("lu-timeseries"))
    .register("BarChart", el("lu-bar-chart"))
    .register("Kpi", el("lu-kpi"))
    .register("Table", el("lu-table"))
    .register("StatusCard", el("lu-status-card"))
    .register("Note", el("lu-note"))
    .register("A2UIView", el("lu-a2ui-widget"))
    .register("SandboxView", el("lu-sandbox-widget"))
    .register("ProgressBar", el("lu-progress"))
    .register("AlertCard", el("lu-alert"))
    .register("StreamingText", el("lu-text"))
    .register("Timeline", el("lu-list"))
    .register("ApprovalCard", el("lu-approval"));
}

export const litRegistry: DomRegistry = createLitRegistry();
