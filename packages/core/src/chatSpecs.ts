// Server-side: what each input node of an experience IS, read from the node's own props, resolved
// through the catalogue. The host passes the resulting lookup to `acceptChatSubmit` as `specOf`, so
// an action is judged against the host's experience and never against anything the client said.
// (Lives apart from `chat.ts`: it needs the catalogue and the tree walker, which bring zod, and a
// browser bundle must not.)

import { type SemanticCatalog, type Surface, resolveSurface } from "./catalog";
import { MAX_INPUT_CHARS, asFields, fieldsProblem, optionsProblem } from "./chatForm";
import type { InputSpec } from "./chatHost";
import { CHAT_KIND, FORM_INPUT_KIND, SELECT_INPUT_KIND, TEXT_INPUT_KIND } from "./chatValue";
import type { Experience } from "./experience";
import { walk } from "./node";

/**
 * widget id → {@link InputSpec}, for every Chat / TextInput / FormInput / SelectInput node of `exp`
 * on `surface`. A node whose props do not form a valid spec is OMITTED, so its actions are refused
 * (`not-an-input`) rather than judged against a guess. A node's widget id is its node id.
 */
export function inputSpecsOf(
  exp: Experience,
  catalog: SemanticCatalog,
  surface: Surface
): Map<string, InputSpec> {
  const out = new Map<string, InputSpec>();
  walk(exp.root, (n) => {
    if (n.kind !== "semantic") return;
    const r = resolveSurface(catalog, n.type, n.typeVersion, surface, n.id);
    if (!r.ok) return;
    const spec = inputSpecFromProps(r.kind, n.props);
    if (spec !== undefined) out.set(n.id, spec);
  });
  return out;
}

/** The spec a node of `kind` with `props` declares, or undefined for another kind / invalid props. */
export function inputSpecFromProps(
  kind: string,
  props: Readonly<Record<string, unknown>>
): InputSpec | undefined {
  switch (kind) {
    case TEXT_INPUT_KIND: {
      const m = props.maxChars;
      return {
        kind: TEXT_INPUT_KIND,
        maxChars:
          typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_INPUT_CHARS
            ? m
            : MAX_INPUT_CHARS,
      };
    }
    case FORM_INPUT_KIND:
      return fieldsProblem(props.fields) === undefined
        ? { kind: FORM_INPUT_KIND, fields: asFields(props.fields) }
        : undefined;
    case SELECT_INPUT_KIND:
      return optionsProblem(props.options) === undefined
        ? {
            kind: SELECT_INPUT_KIND,
            options: props.options as readonly { value: string; label: string }[],
          }
        : undefined;
    case CHAT_KIND:
      return { kind: CHAT_KIND, editable: props.editable === true };
    default:
      return undefined;
  }
}
