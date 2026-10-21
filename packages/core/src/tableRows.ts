// ── Table row actions (U-table) ─────────────────────────────────────────────────────────────────
// A `Table` row can carry actions the host answers. Zod-free and DOM-free: the zod contract
// (`values.ts`) and the browser checker (`kindValues.ts`) both call `tableRowProblems`, so the
// two cannot disagree on a rule or on its words.

/** The action type a table row's button emits: `payload: { action, rowKey }`. */
export const TABLE_ROW_ACTION = "TABLE_ROW_ACTION";
export const MAX_ROW_ACTIONS = 4;

const ROW_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface TableRowAction {
  readonly id: string;
  readonly label: string;
  readonly primary?: boolean;
  readonly destructive?: boolean;
}

export interface RowProblem {
  readonly path: (string | number)[];
  readonly message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `rowKeys` / `rowActions` do not fit `rows`; empty when they do. Total on any input; messages never echo a value. */
export function tableRowProblems(v: {
  rows: readonly unknown[];
  rowKeys?: unknown;
  rowActions?: unknown;
}): RowProblem[] {
  const out: RowProblem[] = [];
  const { rows, rowKeys, rowActions } = v;
  if (rowKeys !== undefined && Array.isArray(rowKeys)) {
    if (rowKeys.length !== rows.length)
      out.push({ path: ["rowKeys"], message: "rowKeys must have one key per row" });
    if (rowKeys.some((k) => typeof k !== "string" || !ROW_KEY.test(k)))
      out.push({ path: ["rowKeys"], message: "rowKeys must be short identifiers" });
    if (new Set(rowKeys).size !== rowKeys.length)
      out.push({ path: ["rowKeys"], message: "rowKeys must be unique" });
  }
  if (rowActions !== undefined && Array.isArray(rowActions)) {
    if (rowKeys === undefined)
      out.push({ path: ["rowActions"], message: "rowActions need rowKeys" });
    if (rowActions.length !== rows.length)
      out.push({ path: ["rowActions"], message: "rowActions must have one list per row" });
    rowActions.forEach((list, r) => {
      if (!Array.isArray(list)) return;
      const at = (message: string): void => void out.push({ path: ["rowActions", r], message });
      if (list.length > MAX_ROW_ACTIONS) at(`a row has at most ${MAX_ROW_ACTIONS} actions`);
      const ids = list.flatMap((a) => (isRecord(a) && typeof a.id === "string" ? [a.id] : []));
      if (new Set(ids).size !== ids.length) at("action ids must be unique within a row");
      if (list.filter((a) => isRecord(a) && a.primary === true).length > 1)
        at("a row has at most one primary action");
      for (const a of list) {
        if (!isRecord(a)) continue;
        if (typeof a.id === "string" && !ACTION_ID.test(a.id))
          at("an action id must be lower-case words");
        if (typeof a.label === "string" && (a.label.length < 1 || a.label.length > 40))
          at("an action label is 1 to 40 characters");
        if (a.primary === true && a.destructive === true)
          at("a destructive action cannot be primary");
      }
    });
  }
  return out;
}
