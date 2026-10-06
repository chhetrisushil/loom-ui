import {
  type DeclaredToolClasses,
  type ProviderSpec,
  mergeDeclaredToolClasses,
  strictestClass,
  toolKey,
  toolsOf,
} from "@loom-ui/core";
import type { DataClass } from "@loom/classify";
import type { CapabilityRef } from "./spi";

/**
 * The host's declared class per TOOL, derived from the capabilities a planner was offered: the
 * strictest `sensitivity` across every capability with the same `toolKey` (the same tool offered at
 * two versions is ONE tool to the read-time floor). This is the table to hand to core's
 * `declaredToolClasses` option, so the planner and the read path can never disagree about a tool.
 */
export function declaredToolClassesFrom(
  capabilities: readonly CapabilityRef[]
): DeclaredToolClasses {
  const out: Record<string, DataClass> = Object.create(null);
  for (const c of capabilities)
    if (c.sensitivity !== undefined)
      out[toolKey(c)] = strictestClass(out[toolKey(c)], c.sensitivity) as DataClass;
  return mergeDeclaredToolClasses(out) ?? {};
}

/**
 * The class a binding on `spec` must carry at least: the strictest declared class over EVERY step
 * of its call graph (an upstream step's tool counts as much as the terminal's), per `toolKey`
 * across all capabilities. `undefined` = nothing the spec calls declares a class. Planner
 * materialization and the conformance kit both use this, and it derives tools through core's
 * `toolsOf`, the same derivation as the read-time floor.
 */
export function requiredClass(
  spec: ProviderSpec,
  capabilities: readonly CapabilityRef[]
): DataClass | undefined {
  const table = declaredToolClassesFrom(capabilities);
  let need: DataClass | undefined;
  for (const k of toolsOf(spec)) {
    const c = Object.hasOwn(table, k) ? table[k] : undefined;
    need = strictestClass(need, c);
  }
  return need;
}
