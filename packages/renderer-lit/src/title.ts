/**
 * The one title rule (ADR 0098 D4), shared by every lit widget and layout: only a NON-EMPTY STRING
 * is a title. `""`, `0`, `5`, `null` — anything else — is none. Truthiness is not the rule: it would
 * print a numeric `5`.
 */
export function titleText(title: unknown): string | undefined {
  return typeof title === "string" && title !== "" ? title : undefined;
}
