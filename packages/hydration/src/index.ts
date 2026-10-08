export {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HYDRATION_SET_EVENT,
  HydrationStore,
  hydrationProjection,
  isReservedHandle,
} from "./projection";
export type {
  HandleSlice,
  HandleState,
  HandleStatus,
  HydrationScope,
  HydrationState,
} from "./projection";
export type { TransientInvoker } from "./invoker";
export { limitInvoker, memoInvoker, signalInvoker } from "./invokers";
export { defineReshapers, jsonPathSelect, outputShapeHashOf } from "./reshape";
export type { ReshapeFailureKind, ReshapeResult, Reshaper, ReshaperRegistry } from "./reshape";
export { DEFAULT_TIME_RANGE, checkParams } from "./params";
export type { ContentRefParamGate } from "./contentRefs";
export type {
  ArgumentHook,
  ArgumentHookContext,
  LoadParams,
} from "./params";
export {
  DEFAULT_DATA_PROVIDERS,
  checkDataProviderConformance,
  defineDataProviders,
  mcpProvider,
} from "./dataProvider";
export type { DataProvider, DataProviderCall, DataProviderRegistry } from "./dataProvider";
export {
  LOOM_EFFECT_KIND,
  TARGET_FAILED,
  TARGET_UNREGISTERED,
  effectPin,
  loomEffectProvider,
} from "./loomEffectProvider";
export type {
  EffectEntry,
  EffectInputSchema,
  LoomEffectProviderOptions,
} from "./loomEffectProvider";
export { executeProvider } from "./provider";
export { stepReferences, terminalSteps, topoWaves } from "./plan";
export type { DriftRecord, ExecuteOptions, InputDriftMode, ProviderOutcome } from "./provider";
export { HydrationCache } from "./cache";
export type { CacheVariant } from "./cache";
export type { HandleLoadResult } from "./scheduler";
export { HydrationController } from "./controller";
export type { ControllerOptions, DriftReport } from "./controller";
export {
  DEFAULT_MAX_BATCH,
  DEFAULT_MAX_CONCURRENT_CALLS,
  SplitHydrationController,
  createServeSurface,
  handleInventory,
  publicFinding,
  serveHandle,
  serveHandles,
} from "./split/index";
export type {
  HandleInventory,
  HandleLoadRequest,
  HandleLoader,
  HandleRef,
  InventoryOptions,
  RevisionFn,
  ServeOptions,
  ServeSurface,
  SplitControllerOptions,
} from "./split/index";
export { SCHEMA_REPAIRED, remapOperation } from "./repair";
export type { SchemaRepairedPayload } from "./repair";
