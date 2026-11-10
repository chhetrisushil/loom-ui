// ── Table row actions and token cells (U-table) ─────────────────────────────────────────────────
// A `Table` row can carry actions the host answers, and a cell can be a list of clickable tokens. Zod-free and DOM-free: the zod contract
// (`values.ts`) and the browser checker (`kindValues.ts`) both call `tableRowProblems`, so the
// two cannot disagree on a rule or on its words.

/** The action type a table row's button emits: `payload: { action, rowKey }`. */
export const TABLE_ROW_ACTION = "TABLE_ROW_ACTION";
export const MAX_ROW_ACTIONS = 4;
/**
 * The action type a token chip emits: `payload: { rowKey, tokenId }` when the table has `rowKeys`,
 * else `{ rowIndex, tokenId }` (the index into `value.rows` as the host sent it, never the displayed
 * position). Never both keys.
 */
export const TABLE_TOKEN = "TABLE_TOKEN";
/** Tokens in one cell: over the cap the value is refused, never cut. */
export const MAX_CELL_TOKENS = 20;
/** A token label is 1 to this many characters of PLAIN text (never parsed as markup). */
export const MAX_TOKEN_LABEL = 80;

const ROW_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface TableRowAction {
  readonly id: string;
  readonly label: string;
  readonly primary?: boolean;
  readonly destructive?: boolean;
}

/** A cell shown as a list of clickable tokens. */
interface TokenCellShape {
  readonly tokens: readonly { readonly id: string; readonly label: string }[];
}

export interface RowProblem {
  readonly path: (string | number)[];
  readonly message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isTokenCell = (c: unknown): c is Record<string, unknown> =>
  isRecord(c) && Array.isArray(c.tokens);

/** A cell as text: a token cell is its labels joined with ", "; null is "", a number its decimal form. */
export function tableCellText(cell: string | number | null | TokenCellShape): string {
  if (cell === null) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number") return String(cell);
  return cell.tokens.map((t) => t.label).join(", ");
}

/** The token-cell rules over every cell; paths point at the cell. Total on any input; no value is echoed. */
function tokenCellProblems(rows: readonly unknown[]): RowProblem[] {
  const out: RowProblem[] = [];
  rows.forEach((row, r) => {
    if (!Array.isArray(row)) return;
    row.forEach((cell, c) => {
      if (!isTokenCell(cell)) return;
      const bad = new Set<string>();
      const tokens = cell.tokens as unknown[];
      if (Object.keys(cell).some((k) => k !== "tokens")) bad.add("a token cell has only tokens");
      if (tokens.length > MAX_CELL_TOKENS) bad.add(`a cell has at most ${MAX_CELL_TOKENS} tokens`);
      const ids: string[] = [];
      for (const t of tokens) {
        if (!isRecord(t)) continue;
        if (Object.keys(t).some((k) => k !== "id" && k !== "label"))
          bad.add("a token has only id and label");
        if (typeof t.id === "string") {
          ids.push(t.id);
          if (!ROW_KEY.test(t.id)) bad.add("a token id must be a short identifier");
        }
        if (typeof t.label === "string" && (t.label.length < 1 || t.label.length > MAX_TOKEN_LABEL))
          bad.add(`a token label is 1 to ${MAX_TOKEN_LABEL} characters`);
      }
      if (new Set(ids).size !== ids.length) bad.add("token ids must be unique within a cell");
      for (const message of bad) out.push({ path: ["rows", r, c], message });
    });
  });
  return out;
}

/** Why `rowKeys` / `rowActions` do not fit `rows`; empty when they do. Total on any input; messages never echo a value. */
export function tableRowProblems(v: {
  rows: readonly unknown[];
  rowKeys?: unknown;
  rowActions?: unknown;
}): RowProblem[] {
  const out: RowProblem[] = [];
  const { rows, rowKeys, rowActions } = v;
  out.push(...tokenCellProblems(rows));
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
