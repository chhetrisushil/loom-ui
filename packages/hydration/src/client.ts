// ── @loom-ui/hydration/client: the browser entry ─────────────────────────────────
// Everything a browser needs for SPLIT hydration and nothing that executes a provider: the split
// controller, the loader contract it calls, the store it publishes to, and param checks. The
// server half (`handleInventory`, `serveHandles`, `executeProvider`, the invokers and reshapers)
// stays on the root entry, `@loom-ui/hydration`, which imports the sandbox and the MCP plugin.
// `clientEntry.test.ts` fails the build if this entry's module graph ever reaches them.
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
export { HYDRATION_VALUES_PREFIX, handleOfPath } from "./path";
export { DEFAULT_TIME_RANGE, checkParams } from "./params";
export type { LoadParams } from "./params";
export type { HandleLoadResult } from "./scheduler";
export { stepReferences, terminalSteps, topoWaves } from "./plan";
export { jsonPathSelect } from "./select";
export type { ReshapeFailureKind, ReshapeResult } from "./select";
export { outputShapeHashOf } from "./shape";
export type { TransientInvoker } from "./invoker";
export type { DriftRecord } from "./provider";
export { SplitHydrationController } from "./split/client";
export type {
  HandleInventory,
  HandleLoadRequest,
  HandleLoader,
  HandleRef,
  SplitControllerOptions,
} from "./split/client";
export { connectConversation, publishChat } from "./chatSource";
export type {
  ConversationConnection,
  ConversationConnectionOptions,
  EventSourceLike,
  FetchResponseLike,
} from "./chatSource";
