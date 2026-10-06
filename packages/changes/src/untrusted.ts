import type { UntrustedText } from "@loom-ui/core";
import { type TaintedValue, tainted } from "@loom/classify";

// ── The summary as loom's untrusted value ─────────────────────────────────────
// A change summary is model text. `UntrustedText` marks it for DISPLAY; when a host feeds it to
// another model (a digest, a notification writer) it must cross as loom's ADR 0085 taint
// (`@loom/classify` `TaintedValue`), which `@loom/llm`'s `guardRequest` refuses in any instruction
// position and fences in a data position. This is a server-side helper: the taint package is a
// loom kernel-side dependency and must not enter a client bundle.
//
// NEVER put a summary in a prompt's instruction (system) position, tainted or not.

/** The summary as an ADR 0085 tainted value, origin `loom-ui:change-summary`. */
export function summaryAsTainted(summary: UntrustedText): TaintedValue<string> {
  return tainted(summary.text, "loom-ui:change-summary");
}
