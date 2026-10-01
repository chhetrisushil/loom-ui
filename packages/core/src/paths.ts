// Zod-free and import-free on purpose: the browser entry (`@loom-ui/core/browser`) re-exports this,
// and a browser bundle must not pay for the Experience schemas to spell a binding path.

/**
 * The hydration projection's top-level key. A widget's binding path is `values.<handle>`, and the
 * projection that hydrates the surface must publish under the same prefix — one spelling, in one
 * place, so the two halves of the contract cannot drift apart in a string literal.
 */
export const HYDRATION_VALUES_PREFIX = "values";

/** The binding path a provider `handle` hydrates through. */
export function hydrationPath(handle: string): string {
  return `${HYDRATION_VALUES_PREFIX}.${handle}`;
}

/**
 * The hydration projection's status key. A binding declares `status.<handle>` as its status
 * channel (loom ADR 0097 D2), in the same projection state its value reads from, so a renderer
 * reads delivery state off the blueprint rather than re-deriving hydration's keying.
 */
export const HYDRATION_STATUS_PREFIX = "status";

/** The status path a provider `handle` publishes its delivery state under. */
export function hydrationStatusPath(handle: string): string {
  return `${HYDRATION_STATUS_PREFIX}.${handle}`;
}
