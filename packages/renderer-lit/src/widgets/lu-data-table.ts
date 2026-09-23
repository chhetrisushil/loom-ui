import type { Widget } from "@loom/blueprint-runtime";
import { type TemplateResult, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { describeValue } from "../a11y";
import { measure } from "../format";
import { LuWidget } from "./base";

/** Cap DOM rows so a tool returning tens of thousands of rows can't build hundreds of
 * thousands of cells and jank the main thread. The full set is still sorted; only the DOM is
 * windowed, extended on demand via "show more". */
const INITIAL_ROWS = 200;
const ROW_STEP = 200;

type Row = Record<string, unknown>;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined;
}

/** Own properties only: a column named `__proto__` reads as absent, never as the row's prototype. */
function cell(row: Row, column: string): unknown {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

function compareCells(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

@customElement("lu-data-table")
export class LuDataTable extends LuWidget {
  readonly kind = "DataTable";

  @state() private sortCol: string | null = null;
  @state() private sortDir: 1 | -1 = -1;
  @state() private visibleRows = INITIAL_ROWS;

  // Memoize the derived columns and the per-column numeric detection so neither is recomputed
  // (both O(rows×cols)) on every sort click — only when the value or the widget changes.
  // A `Map`, not an object: a column literally named `__proto__` must land as an ordinary entry
  // rather than reaching the prototype setter (and reading it back as `Object.prototype`, which
  // is truthy, so every cell in that column would right-align as "numeric").
  private cacheRef: { value: unknown; widget: Widget } | undefined;
  private columnsCache: string[] = [];
  private numericCache = new Map<string, boolean>();

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
      cursor: pointer;
      user-select: none;
      border-bottom: 1px solid var(--lu-border, #30363d);
    }
    td {
      color: var(--lu-text, #e6edf3);
      border-bottom: 1px solid var(--lu-grid, rgba(139, 148, 158, 0.08));
    }
    td.num {
      font-variant-numeric: tabular-nums;
      text-align: end;
    }
    th.num {
      text-align: end;
    }
    tr:hover td {
      background: rgba(99, 102, 241, 0.06);
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

  /**
   * Columns come from the widget when declared; otherwise from the UNION of every row's keys, in
   * first-seen order — mirroring loom's `DataTableRenderer.deriveColumns`. Sampling the first row
   * alone silently drops every column that row happens to be missing, which is the table
   * equivalent of a filter nobody asked for.
   */
  private analyze(rows: readonly Row[]): {
    columns: readonly string[];
    numeric: Map<string, boolean>;
  } {
    const ref = this.cacheRef;
    if (ref === undefined || ref.value !== this.value || ref.widget !== this.widget) {
      const declared = (this.widget.props as { columns?: string[] }).columns;
      let columns: string[];
      if (declared !== undefined) {
        columns = declared;
      } else {
        const seen = new Set<string>();
        for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
        columns = [...seen];
      }
      const numeric = new Map<string, boolean>();
      for (const c of columns)
        numeric.set(
          c,
          rows.every((r) => typeof cell(r, c) === "number" || isEmpty(cell(r, c)))
        );
      this.columnsCache = columns;
      this.numericCache = numeric;
      this.cacheRef = { value: this.value, widget: this.widget };
    }
    return { columns: this.columnsCache, numeric: this.numericCache };
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const rows = this.value as Row[];
    const { columns, numeric } = this.analyze(rows);
    let sorted = rows;
    if (this.sortCol !== null) {
      const c = this.sortCol;
      const dir = this.sortDir;
      sorted = [...rows].sort((a, b) => {
        if (isEmpty(cell(a, c))) return 1;
        if (isEmpty(cell(b, c))) return -1;
        return compareCells(cell(a, c), cell(b, c)) * dir;
      });
    }
    const total = sorted.length;
    const shown = Math.min(this.visibleRows, total);
    const windowed = shown < total ? sorted.slice(0, shown) : sorted;
    return html`<table>
        <caption class="sr-only">${describeValue("DataTable", rows, this.title_, this.widget.props)}</caption>
        <thead>
          <tr>
            ${columns.map(
              (c) => html`<th class=${numeric.get(c) ? "num" : ""} @click=${() => this.sortBy(c)}>
                ${c}${this.sortCol === c ? (this.sortDir === 1 ? " ↑" : " ↓") : ""}
              </th>`
            )}
          </tr>
        </thead>
        <tbody>
          ${windowed.map(
            (r) => html`<tr>
              ${columns.map((c) => {
                const v = cell(r, c);
                return html`<td class=${numeric.get(c) ? "num" : ""}>
                  ${isEmpty(v) ? "—" : typeof v === "number" ? measure(v) : String(v)}
                </td>`;
              })}
            </tr>`
          )}
        </tbody>
      </table>
      ${
        shown < total
          ? html`<div class="more">
              Showing ${shown} of ${total} rows
              <button @click=${this.showMore}>Show ${Math.min(ROW_STEP, total - shown)} more</button>
            </div>`
          : nothing
      }`;
  }

  private showMore = (): void => {
    this.visibleRows += ROW_STEP;
  };

  private sortBy(col: string): void {
    if (this.sortCol === col) {
      this.sortDir = this.sortDir === 1 ? -1 : 1;
    } else {
      this.sortCol = col;
      this.sortDir = -1;
    }
    this.visibleRows = INITIAL_ROWS; // re-window from the top on a new sort
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-data-table": LuDataTable;
  }
}
