import {
  type TableCell,
  type TableValue,
  tableColumnFormat,
  tableColumnLabel,
} from "@loom-ui/core/browser";
import { pluralForms } from "@loom-ui/core/messages";
import { type TemplateResult, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { describeValue } from "../a11y";
import { measure } from "../format";
import { formattingLocale } from "../i18n";
import { tPlural } from "../plural";
import { say } from "../say";
import { LuWidget } from "./base";

/** Same DOM window as lu-data-table: the full set is sorted, only the DOM is capped. */
const INITIAL_ROWS = 200;
const ROW_STEP = 200;

/** The cell at column `i`; a row shorter than the columns reads as a missing value. */
const at = (row: readonly TableCell[], i: number): TableCell => row[i] ?? null;

function compareCells(a: TableCell, b: TableCell): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last, whatever the direction
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  // At least one cell is a string (a column may legitimately mix types): compare as text but
  // numeric-aware, so "9" sorts before "10" instead of by character code, and a numeric-looking
  // string compares sanely against an actual number in the same column. The collation is the
  // FORMATTING locale's (the one the cells are drawn in), never the host's own.
  return String(a).localeCompare(String(b), formattingLocale(), {
    numeric: true,
    sensitivity: "base",
  });
}

// A columnar table: headings (string or {label, format}) and rows of cells in column order,
// each numeric cell formatted with ITS column's semantics. Rendering walks the columns, so a
// surplus cell is not shown and a missing one is "—" — unlike loom's DataTable, which stays
// records.
@customElement("lu-table")
export class LuTable extends LuWidget {
  readonly kind = "Table";

  @state() private sortCol: number | null = null;
  @state() private sortDir: 1 | -1 = -1;
  @state() private visibleRows = INITIAL_ROWS;

  // Per-column numeric detection is O(rows×cols); memoised per value, not per sort click.
  private numericFor: unknown;
  private numericCache: boolean[] = [];

  static styles = css`
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      text-align: start;
      padding: 6px 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 220px;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--lu-panel, #161b22);
      color: var(--lu-text-dim, #8b949e);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--lu-border, #30363d);
    }
    th button {
      all: unset;
      display: block;
      width: 100%;
      box-sizing: border-box;
      cursor: pointer;
      user-select: none;
      font: inherit;
      color: inherit;
      text-transform: inherit;
      letter-spacing: inherit;
    }
    th button:focus-visible {
      outline: 2px solid var(--lu-accent, #6366f1);
      outline-offset: -2px;
    }
    td {
      color: var(--lu-text, #e6edf3);
      border-bottom: 1px solid var(--lu-grid, rgba(139, 148, 158, 0.08));
    }
    td.num,
    th.num {
      font-variant-numeric: tabular-nums;
      text-align: end;
    }
    .more {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      color: var(--lu-text-dim, #8b949e);
      font-size: 11px;
    }
    .more button {
      background: rgba(99, 102, 241, 0.12);
      color: var(--lu-text, #e6edf3);
      border: 1px solid var(--lu-border, #30363d);
      border-radius: 6px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 11px;
    }
    .more button:hover {
      background: rgba(99, 102, 241, 0.22);
    }
  `;

  private numeric(v: TableValue): readonly boolean[] {
    if (this.numericFor !== v) {
      this.numericCache = v.columns.map((_, i) =>
        v.rows.every((r) => {
          const c = at(r, i);
          return c === null || typeof c === "number";
        })
      );
      this.numericFor = v;
    }
    return this.numericCache;
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as TableValue;
    const labels = v.columns.map(tableColumnLabel);
    const formats = v.columns.map(tableColumnFormat);
    const numeric = this.numeric(v);
    let rows = v.rows;
    const col = this.sortCol;
    if (col !== null && col < labels.length) {
      const dir = this.sortDir;
      rows = [...rows].sort((a, b) => {
        const x = at(a, col);
        const y = at(b, col);
        if (x === null || y === null) return compareCells(x, y);
        return compareCells(x, y) * dir;
      });
    }
    const total = rows.length;
    const shown = Math.min(this.visibleRows, total);
    const windowed = shown < total ? rows.slice(0, shown) : rows;
    return html`<table>
        <caption class="sr-only">${describeValue("Table", v, this.title_)}</caption>
        <thead>
          <tr>
            ${labels.map(
              (label, i) => html`<th
                class=${numeric[i] ? "num" : ""}
                aria-sort=${this.sortCol === i ? (this.sortDir === 1 ? "ascending" : "descending") : "none"}
              >
                <button type="button" @click=${() => this.sortBy(i)}>
                  ${label}${this.sortCol === i ? (this.sortDir === 1 ? " ↑" : " ↓") : ""}
                </button>
              </th>`
            )}
          </tr>
        </thead>
        <tbody>
          ${windowed.map(
            (r) => html`<tr>
              ${labels.map((_, i) => {
                const c = at(r, i);
                return html`<td class=${numeric[i] ? "num" : ""}>
                  ${c === null ? "—" : typeof c === "number" ? measure(c, formats[i]) : c}
                </td>`;
              })}
            </tr>`
          )}
        </tbody>
      </table>
      ${
        shown < total
          ? html`<div class="more">
              ${say("lu.table.showing", { shown, total, noun: tPlural("lu.plural.row", total, pluralForms("lu.plural.row")) })}
              <button @click=${this.showMore}>
                ${say("lu.table.showMore", { n: Math.min(ROW_STEP, total - shown) })}
              </button>
            </div>`
          : nothing
      }`;
  }

  private showMore = (): void => {
    this.visibleRows += ROW_STEP;
  };

  private sortBy(col: number): void {
    if (this.sortCol === col) this.sortDir = this.sortDir === 1 ? -1 : 1;
    else {
      this.sortCol = col;
      this.sortDir = -1;
    }
    this.visibleRows = INITIAL_ROWS;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-table": LuTable;
  }
}
