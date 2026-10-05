// `@loom-ui/core/browser` — the part of core a BROWSER renderer needs, with no zod and no
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
  CompileFingerprintInput,
  CurrentHead,
  StampedAction,
  ViewedBinding,
  ViewedVersion,
} from "./action";
export {
  DELTA_FORMAT,
  deltaDirection,
  effectiveFormat,
  formatFromUnit,
  formatSemanticNumber,
  semanticNumberFormatOptions,
  unitSuffix,
} from "./format";
export type { DeltaDirection } from "./format";
export {
  FRAMEWORK_KINDS,
  checkKindValue,
  isLocalizedText,
  tableColumnFormat,
  tableColumnLabel,
} from "./kindValues";
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
  StatusCardValue,
  TableCell,
  TableColumn,
  TableValue,
  TimeSeriesValue,
} from "./values";
export type { Finding } from "./experience";
