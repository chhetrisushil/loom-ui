import type { Experience } from "./experience";
import { nodeIds } from "./node";

// Node identity across a structural change is loom's question too (ADR 0094), asked over id
// sets; the same function answers it here. An edit that keeps ids is a revision; one that drops
// them re-identifies the view.
export { preservesNodes } from "@loom/blueprint-runtime";
export type { IdentityFinding, IdentityReport } from "@loom/blueprint-runtime";

export function experienceNodeIds(exp: Experience): string[] {
  return nodeIds(exp.root);
}
