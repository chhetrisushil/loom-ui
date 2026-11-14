// `@loomwork/ui-renderer-lit/register` — the "register everything" convenience entry.
//
// Importing the package used to register every `lu-*` element as a side effect, so a host could not
// take one widget without all of them. Registration is now explicit. A host that wants the old
// behaviour adds this one line:
//
//   import "@loomwork/ui-renderer-lit/register";
//
// (or `import { defineAll } from "@loomwork/ui-renderer-lit/register"` and calls it, e.g. to defer it). A host that wants ONE widget imports its element
// entry instead, e.g. `import "@loomwork/ui-renderer-lit/elements/lu-kpi"`.
import { defineAll } from "./defineAll";

defineAll();

export { defineAll };
