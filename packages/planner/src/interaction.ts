import { type Experience, type Finding, Operation, type Provenance, findNode } from "@loom-ui/core";
import type { WidgetAction } from "@loom/blueprint-runtime";
import type { ContentRef } from "@loom/plugin-content";

/** The one action type the framework interprets as an EXPERIENCE operation (spec §7.2). */
export const EXPERIENCE_OP_ACTION = "experience.op";

export type Interpretation =
  | { readonly kind: "experience"; readonly op: Operation }
  | { readonly kind: "business"; readonly action: WidgetAction }
  | { readonly kind: "refused"; readonly finding: Finding };

const refuse = (code: string, message: string): Interpretation => ({
  kind: "refused",
  finding: { code, severity: "error", message },
});

/**
 * Two authorisation domains. Everything that is not an `experience.op` is BUSINESS and goes to
 * loom's ordinary effect path untouched — the framework authorises nothing there. An `experience.op`
 * is admitted only when its payload parses as an Operation, is not a `prompt` (a planner's op, not a
 * user's click), does not touch the root, and names a node that exists. Three refusals are
 * structural rather than app policy: `prompt` (a planner's op, not a user's click), `remapProvider`
 * (a data-plane re-pin authored by a planner's revise or the app's durable repair, never a widget),
 * and the root (immutable from this surface). Who may EDIT the lineage otherwise is the app's
 * policy, applied after this returns.
 */
export function interpretAction(exp: Experience, action: WidgetAction): Interpretation {
  if (action.type !== EXPERIENCE_OP_ACTION) return { kind: "business", action };
  const parsed = Operation.safeParse(action.payload);
  if (!parsed.success)
    return refuse(
      "not-an-operation",
      `experience.op payload is not an Operation: ${parsed.error.issues[0]?.message ?? "invalid"}`
    );
  const op = parsed.data;
  if (op.type === "prompt")
    return refuse(
      "prompt-not-interactive",
      "a prompt op is authored by a planner, not by a widget action"
    );
  if (op.type === "remapProvider")
    return refuse(
      "provider-op-not-interactive",
      "a provider re-pin is authored by a planner or the app's repair path, not by a widget action"
    );
  const nodeId = "nodeId" in op ? op.nodeId : op.type === "insertNode" ? op.parentId : undefined;
  if (nodeId === exp.root.id && op.type !== "insertNode")
    return refuse("root-immutable", "an action may not remove, move or edit the root");
  if (nodeId !== undefined && findNode(exp.root, nodeId) === undefined)
    return refuse("missing-node", `node "${nodeId}" not found`);
  return { kind: "experience", op };
}

/** §7.3 — an agent's ops always yield a new artifact; SHOWING it is this separate app-level event. */
export const EXPERIENCE_PROMOTED = "EXPERIENCE_PROMOTED";
export interface ExperiencePromotedPayload {
  readonly ref: ContentRef;
  readonly experienceId: string;
  readonly versionHash: string;
  readonly by: Provenance;
}
