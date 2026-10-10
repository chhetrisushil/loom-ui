/**
 * Define a custom element once. Idempotent: a tag already defined (by this module graph or another
 * copy of the package) is left alone, so calling a `define*` function twice, or from two bundles,
 * never throws the "already defined" error `customElements.define` does.
 */
export function defineElement(tag: string, ctor: CustomElementConstructor): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tag) === undefined) customElements.define(tag, ctor);
}
