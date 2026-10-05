import type { MCPToolNode } from "./experience";

// ── A step's kind ─────────────────────────────────────────────────────────────
// A provider step names WHERE its data comes from by a KIND (U3): an open id a host registers a
// data provider for (hydration's `DataProviderRegistry`). Core knows no kind's behaviour — only
// the id's spelling and the one rule that keeps content addresses stable: the original kind, MCP,
// is the IMPLICIT one. An MCP step carries no `kind` key at all, so an experience written before
// kinds existed hashes exactly as it did; `kind: "mcp"` spelled out is refused, so one meaning has
// one spelling (two spellings would be two content addresses for the same experience).

/** The kind of a step that declares none. */
export const DEFAULT_STEP_KIND = "mcp";

/** A kind id: lower-case, digits and `-`, starting with a letter. No `:` — `toolKey` joins on it. */
export const STEP_KIND_PATTERN = /^[a-z][a-z0-9-]*$/;
export const MAX_STEP_KIND_LENGTH = 64;

/** The kind a step runs under. */
export const stepKind = (step: Pick<MCPToolNode, "kind">): string => step.kind ?? DEFAULT_STEP_KIND;

/**
 * The identity a step's TARGET has for class stickiness (`Experience.toolClasses`): the bare
 * `toolName` for an MCP step (so every class recorded before kinds existed still applies), and
 * `<kind>:<toolName>` for any other kind. Namespaced, so a loom effect and an MCP tool that
 * happen to share a name do not share a class. (A MCP tool literally named `x:y` can collide with
 * kind `x`'s target `y`; the collision only ever UNIFIES two classes — it can raise a class, never
 * shed one — so it fails closed.)
 */
export const toolKey = (step: Pick<MCPToolNode, "kind" | "toolName">): string =>
  step.kind === undefined ? step.toolName : `${step.kind}:${step.toolName}`;
