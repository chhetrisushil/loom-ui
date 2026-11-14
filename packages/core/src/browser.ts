// `@loomwork/ui-core/browser` — the part of core a BROWSER renderer needs, with no zod and no
// Experience schemas behind it. Nothing here may import (at runtime) a module that imports zod:
// `browserEntry.test.ts` bundles this the way a browser bundler does and fails on a byte of it.
//
// What a renderer needs: how a number reads (`format`), the verdict on a bound value
// (`checkKindValue`, the same findings as the main entry's), the kind and column vocabulary, and
// the binding-path spelling. Everything else — the Experience, operations, the catalogue, the
// compiler — is server/authoring-side and stays on the main entry.
export {
  actionFreshness,
  compileFingerprint,
  isStaleAction,
  parseBlueprintId,
  viewedVersionOf,
} from "./action";
export type {
  ActionFreshness,
  ActionOutcome,
  CompileFingerprintInput,
  CurrentHead,
  StampedAction,
  ViewedBinding,
  ViewedVersion,
} from "./action";
// The audience rule, restated nowhere: hydration's scope key imports THIS (viewer.ts imports only types).
export { isBroadcast } from "./viewer";
export {
  DELTA_FORMAT,
  deltaDirection,
  effectiveFormat,
  formatFromUnit,
  formatSemanticNumber,
  isTimeFormat,
  isTimeZone,
  TIME_GRANULARITIES,
  semanticNumberFormatOptions,
  unitSuffix,
} from "./format";
export type { DeltaDirection, TimeGranularity } from "./format";
export { formatTimeLabel } from "./timeWords";
export type { TimeLabelKey, TimeLabelWords } from "./timeWords";
export {
  FRAMEWORK_KINDS,
  checkKindValue,
  hasKindContract,
  isLocalizedText,
  tableColumnFormat,
  tableColumnLabel,
} from "./kindValues";
// The chat, media and diagram contracts are DEFERRED (see kindValues.ts): until one of these loads
// them, a value of those kinds is refused, never passed. renderer-lit's defineX() calls them.
export { useChatContracts } from "./contractsChat";
export { useDiagramContracts } from "./contractsDiagram";
export { useMediaContracts } from "./contractsMedia";
// The media surface (U9) is its own subpath, `@loomwork/ui-core/media`: only the CONTRACT rides here (deferred: inside
// `checkKindValue`), so a page that draws no media does not carry the rest.
export type { ContractRegistry, ValueContract } from "./kindValues";
export {
  HYDRATION_STATUS_PREFIX,
  HYDRATION_VALUES_PREFIX,
  hydrationPath,
  hydrationStatusPath,
} from "./paths";
export type {
  BarChartValue,
  KpiValue,
  SemanticFormat,
  TimeFormat,
  StatusCardValue,
  ProseValue,
  DiagramValue,
  WidgetRefs,
  TableCell,
  TableColumn,
  TableToken,
  TableTokenCell,
  TableValue,
  TimeSeriesValue,
} from "./values";
export {
  MAX_CELL_TOKENS,
  MAX_ROW_ACTIONS,
  MAX_TOKEN_LABEL,
  TABLE_ROW_ACTION,
  TABLE_TOKEN,
  tableCellText,
  tableRowProblems,
} from "./tableRows";
export {
  DIAGRAM_LAYOUTS,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_NODES,
  diagramProblems,
} from "./diagramStructure";
export type { DiagramLayout, DiagramProblem } from "./diagramStructure";
export { diagramGraph } from "./diagramGraph";
export type { DiagramGraph, ResolvedEdge } from "./diagramGraph";
export { OUTLINE_ARROW, OUTLINE_DASH, diagramOutline } from "./diagramText";
export type { OutlineLine } from "./diagramText";
export type { TableRowAction } from "./tableRows";
export {
  MAX_WIDGET_REFS,
  MAX_WIDGET_REF_LABEL,
  REF_OPEN_ACTION,
  WIDGET_REF_KINDS,
  widgetRefProblems,
  widgetRefsOf,
} from "./widgetRefs";
export type { WidgetRef, WidgetRefProblem } from "./widgetRefs";
export type { Finding } from "./experience";
export { MAX_CHUNK_TEXT, MAX_STREAM_TEXT, appendChunk } from "./streamText";
export type { AppendResult, StreamedText, TextChunk } from "./streamText";
export {
  REFERENCE_CONTAINER_ROLES,
  STEPPER_ROLE,
  TABS_ROLE,
  roleChildProblems,
} from "./containerRoles";
export type { ContainerRoleSpec, RoleChild, RoleChildren } from "./containerRoles";
// The fixed-words catalogue (U14) is its own subpath, `@loomwork/ui-core/messages`: a page that draws no fixed
// words (the hydration client) must not carry the ~8 kB catalogue.
