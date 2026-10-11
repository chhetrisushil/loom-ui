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
export { orderKeyAfterAll, orderKeyBetween } from "./order";
export type { OrderKeyOptions } from "./order";
export {
  ExperienceNode,
  GRID_COLUMNS,
  GRID_LINE_WARN_ABOVE,
  ContainerOwner,
  GridColumn,
  GridLine,
  LayoutRole,
  LocalizedText,
  MAX_TREE_DEPTH,
  NodeId,
  OrderKey,
  Priority,
  ProjectionBinding,
  Sensitivity,
  Span,
  findNode,
  isContainer,
  isPlaced,
  nodeIds,
  normalize,
  placementOf,
  placementProblems,
  rebuild,
  roleProblem,
  treeDepth,
  walk,
} from "./node";
export {
  REFERENCE_CONTAINER_ROLES,
  STEPPER_ROLE,
  TABS_ROLE,
  containerRoleFindings,
  roleChildProblems,
} from "./containerRoles";
export type { ContainerRoleSpec, RoleChild, RoleChildren } from "./containerRoles";
export type { ContainerNode, Placement, SemanticNode } from "./node";
export {
  Experience,
  Intent,
  MCPToolNode,
  ProviderSpec,
  ProviderStep,
  VocabularyFloor,
  experienceArtifact,
  genesis,
} from "./experience";
export type { Finding, GenesisInput } from "./experience";
export { type ApplyOptions, Operation, Provenance, apply, applyAt, replay } from "./operations";
export { carryClasses, inheritedClass } from "./classes";
export type { DeclaredToolClasses, ReadPolicy, UndeclaredToolPolicy } from "./classes";
export {
  UNDECLARED_TOOL_CLASS,
  mergeDeclaredToolClasses,
  mergeReadPolicy,
  toolsOf,
} from "./classes";
export { DEFAULT_STEP_KIND, STEP_KIND_PATTERN, stepKind, toolKey } from "./steps";
export type { OpResult, RecordedOperation } from "./operations";
export { keyConflicts, mergeExperiences } from "./merge";
export type { KeyConflict, MergeConflict, MergeConflictKind, MergeResult } from "./merge";
export { experienceNodeIds, preservesNodes } from "./identity";
export type { IdentityFinding, IdentityReport } from "./identity";
export {
  checkFloor,
  compareVersions,
  defineSemanticCatalog,
  findEntry,
  resolveSurface,
  WELL_KNOWN_SURFACES,
  catalogContractFindings,
  validateExperience,
} from "./catalog";
export type {
  ValidateOptions,
  ExperienceValidation,
  KindContract,
  Resolution,
  SemanticCatalog,
  SemanticEntry,
  Surface,
  SurfaceResolution,
} from "./catalog";
export type { ContractRegistry, ValueContract } from "./kindValues";
export {
  ACCEPT_PATTERN,
  DEFAULT_MEDIA_MAX_BYTES,
  MAX_ADDRESS_LENGTH,
  MAX_DECLARED_MEDIA_BYTES,
  MAX_MEDIA_ALT_LENGTH,
  MAX_MEDIA_NAME_LENGTH,
  MEDIA_ALLOWED_PROPS,
  MEDIA_ATTACH_ACTION,
  MEDIA_INPUT_KIND,
  MEDIA_KINDS,
  MEDIA_TEXT_PROPS,
  MEDIA_TYPE_VERSION,
  MAX_EMBEDDED_SCAN,
  acceptMediaAttach,
  addressProblem,
  checkFileName,
  checkMediaUrl,
  containsEmbeddedRef,
  embeddedRefWarnings,
  isActiveMediaType,
  looksLikeLiteralRef,
  isSameOriginMediaUrl,
  cleanMediaText,
  describeMedia,
  formatBytes,
  isMediaInputKind,
  isMediaKind,
  isMediaRef,
  matchesAccept,
  maxBytesFor,
  mediaCatalogEntries,
  mediaFamily,
  mediaPropFindings,
  mediaTypeProblem,
  mediaValueIssues,
  safeFileName,
} from "./media";
export type {
  IssuedMedia,
  MediaAttachRefusal,
  MediaIssue,
  MediaKind,
  MediaOrigin,
  MediaPolicy,
  MediaRef,
  MediaRequest,
  MediaResolution,
  MediaResolver,
  MediaUploadHandler,
  MediaUploadRequest,
  MediaUploadResult,
  UploadCandidate,
} from "./media";
// U8: the chat and input vocabulary. The zod-free half rides `@loom-ui/core/chat` for a browser.
export * from "./chat";
export { inputSpecFromProps, inputSpecsOf } from "./chatSpecs";
export {
  CONTENT_REF_KEYWORD,
  MAX_ARG_DEPTH,
  MAX_ARG_VALUES,
  MAX_CONTENT_REF_PATHS,
  MAX_SCHEMA_NODES,
  MAX_SCHEMA_PATH_DEPTH,
  STEP_TEMPLATE_SOURCE,
  contentRefArgFindings,
  contentRefEntry,
  contentRefProduces,
  EMPTY_CONTENT_REF_TABLE,
  MAX_LITERAL_FINDINGS,
  parseContentRefTable,
  parseStepReference,
  pathCovers,
  provenIn,
  stripNullContentRefs,
  contentRefPaths,
  formatArgPath,
  isLegitimateContentRef,
  markedTopLevelKeys,
  mergeContentRefEntries,
} from "./contentRefArgs";
export type {
  ArgPath,
  ContentRefArgOptions,
  ContentRefEntry,
  StepReference,
  ContentRefPaths,
  ContentRefTable,
} from "./contentRefArgs";
export { loomCatalogFor } from "./loomCatalog";
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
  HYDRATION_STATUS_PREFIX,
  HYDRATION_VALUES_PREFIX,
  RESTRICTED_LABEL,
  compile,
  hydrationPath,
  hydrationStatusPath,
} from "./compile";
export type { CompileOptions, CompileResult } from "./compile";
export {
  CompileMemo,
  DEFAULT_COMPILE_MEMO_MAX,
  createCompileMemo,
  defaultCompileMemo,
} from "./compileMemo";
export type { CompileMemoOptions } from "./compileMemo";
export { MIN_ALIAS_KEY_BYTES, PlaceholderKeyError, placeholderAlias } from "./alias";
export type { AliasKey } from "./alias";
export { planProjectionBindings } from "./projections";
export type {
  ProjectionCatalog,
  ProjectionDescriptor,
  ProjectionPlan,
  ProjectionVerdict,
} from "./projections";
export {
  experienceHandles,
  handleKinds,
  handleKindsWithMedia,
  hasMediaTypeNodes,
} from "./handles";
export type { HandleUse } from "./handles";
export {
  BarChartValue,
  ChartAxis,
  FRAMEWORK_KINDS,
  KpiValue,
  SemanticFormat,
  StatusCardValue,
  StatusLevel,
  TableCell,
  TableColumn,
  TableValue,
  TimeSeriesValue,
  checkKindValue,
  hasKindContract,
  isFrameworkContractKind,
  kindValueContract,
  kindValueContracts,
  tableColumnFormat,
  tableColumnLabel,
} from "./values";
export { mayView, strictestClass } from "./viewer";
export type { Viewer } from "./viewer";
export {
  ATTENTION_LEVELS,
  CHANGE_KINDS,
  DEFAULT_MAX_ENTRIES,
  MAX_ENTRIES_CAP,
  MAX_SUMMARY_LENGTH,
  boundSummary,
  defaultAttention,
  describeChange,
  experienceClassFloor,
  inspectExperience,
  untrustedSummary,
} from "./change";
export type {
  Attention,
  ChangeDescription,
  ChangeEntry,
  ChangeKind,
  DescribeOptions,
  ExperienceInspection,
  UntrustedText,
} from "./change";
export {
  MAX_LEDGER_NODES,
  MAX_STEP_OPS,
  cleanProvenance,
  emptyLedger,
  explainNode,
  foldProvenance,
} from "./provenance";
export type {
  ExplainOptions,
  ExplainedEntry,
  NodeExplanation,
  NodeLedger,
  NodeSource,
  ProvenanceEntry,
  ProvenanceLedger,
  ProvenanceStep,
  VersionNote,
} from "./provenance";
export type { HeadChange, HeadSignal } from "./heads";
export { MAX_CHUNK_TEXT, MAX_STREAM_TEXT, appendChunk } from "./streamText";
export type { AppendResult, StreamedText, TextChunk } from "./streamText";
export { OpStream } from "./opStream";
export {
  MAX_SEEN_NODE_IDS,
  MAX_SEEN_SOURCES,
  MAX_SEEN_TOTAL_BYTES,
  MAX_SEEN_VALUE_BYTES,
  SEEN_CLASSES,
  redactSeen,
  seenToState,
  snapshotSeen,
} from "./seen";
export type {
  RedactedSeen,
  SeenClass,
  SeenEntry,
  SeenReader,
  SeenReading,
  SeenSnapshot,
  SeenSource,
  SeenState,
  SnapshotOptions,
} from "./seen";
// U14: the fixed-words catalogue and its host override.
export {
  LU_MESSAGES,
  LU_MESSAGE_KEYS,
  createSay,
  fill,
  lookupMessage,
  pluralForms,
  sayEnglish,
  selectPlural,
} from "./messages";
export type { LuI18n, LuMessageKey, LuMessageVars, PluralForms, Say } from "./messages";
export { providerGraphFindings } from "./providerGraph";
export type { GraphProvider, GraphStep } from "./providerGraph";
