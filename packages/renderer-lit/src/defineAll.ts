import { defineA2uiView } from "./define/lu-a2ui-view";
import { defineBarChart } from "./define/lu-bar-chart";
import { defineChat } from "./define/lu-chat";
import { defineChatMissing } from "./define/lu-chat-missing";
import { defineDataTable } from "./define/lu-data-table";
import { defineEmbedded } from "./define/lu-embedded";
import { defineInputs } from "./define/lu-inputs";
import { defineKpi } from "./define/lu-kpi";
import { defineLocalePicker } from "./define/lu-locale-picker";
import { defineMedia } from "./define/lu-media";
import { defineMediaMissing } from "./define/lu-media-missing";
import { defineMetricCard } from "./define/lu-metric-card";
import { defineNote } from "./define/lu-note";
import { defineSandbox } from "./define/lu-sandbox";
import { defineSimple } from "./define/lu-simple";
import { defineStatusBadge } from "./define/lu-status-badge";
import { defineStatusCard } from "./define/lu-status-card";
import { defineTable } from "./define/lu-table";
import { defineTimeRangePicker } from "./define/lu-time-range-picker";
import { defineTimeseries } from "./define/lu-timeseries";

/** Register EVERY `lu-*` element (idempotent). The convenience for a host that draws the whole default registry. */
export function defineAll(): void {
  defineA2uiView();
  defineBarChart();
  defineChatMissing();
  defineChat();
  defineDataTable();
  defineEmbedded();
  defineInputs();
  defineKpi();
  defineLocalePicker();
  defineMediaMissing();
  defineMedia();
  defineMetricCard();
  defineNote();
  defineSandbox();
  defineSimple();
  defineStatusBadge();
  defineStatusCard();
  defineTable();
  defineTimeRangePicker();
  defineTimeseries();
}
