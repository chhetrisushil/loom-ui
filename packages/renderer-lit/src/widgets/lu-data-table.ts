import { type TemplateResult, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
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

  // Memoize the per-column numeric detection so it isn't recomputed (O(rows×cols)) on every
  // sort click — only when the underlying value reference changes.
  private numericRef?: unknown;
  private numericCache: Record<string, boolean> = {};

  static styles = css`
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
      background: var(--gx-panel, #161b22);
      color: var(--gx-text-dim, #8b949e);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      cursor: pointer;
      user-select: none;
      border-bottom: 1px solid var(--gx-border, #30363d);
    }
    td {
      color: var(--gx-text, #e6edf3);
      border-bottom: 1px solid var(--gx-grid, rgba(139, 148, 158, 0.08));
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
      color: var(--gx-text-dim, #8b949e);
      font-size: 11px;
    }
    .more button {
      background: rgba(99, 102, 241, 0.12);
      color: var(--gx-text, #e6edf3);
      border: 1px solid var(--gx-border, #30363d);
      border-radius: 6px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 11px;
    }
    .more button:hover {
      background: rgba(99, 102, 241, 0.22);
    }
  `;

  private columns(rows: readonly Row[]): string[] {
    const declared = (this.widget.props as { columns?: string[] }).columns;
    return declared ?? Object.keys(rows[0] ?? {});
  }

  private numericColumns(
    rows: readonly Row[],
    columns: readonly string[]
  ): Record<string, boolean> {
    if (this.numericRef !== this.value) {
      const cache: Record<string, boolean> = {};
      for (const c of columns)
        cache[c] = rows.every((r) => typeof r[c] === "number" || isEmpty(r[c]));
      this.numericCache = cache;
      this.numericRef = this.value;
    }
    return this.numericCache;
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const rows = this.value as Row[];
    const columns = this.columns(rows);
    const numeric = this.numericColumns(rows, columns);
    let sorted = rows;
    if (this.sortCol !== null) {
      const c = this.sortCol;
      const dir = this.sortDir;
      sorted = [...rows].sort((a, b) => {
        if (isEmpty(a[c])) return 1;
        if (isEmpty(b[c])) return -1;
        return compareCells(a[c], b[c]) * dir;
      });
    }
    const total = sorted.length;
    const shown = Math.min(this.visibleRows, total);
    const windowed = shown < total ? sorted.slice(0, shown) : sorted;
    return html`<table>
        <thead>
          <tr>
            ${columns.map(
              (c) => html`<th class=${numeric[c] ? "num" : ""} @click=${() => this.sortBy(c)}>
                ${c}${this.sortCol === c ? (this.sortDir === 1 ? " ↑" : " ↓") : ""}
              </th>`
            )}
          </tr>
        </thead>
        <tbody>
          ${windowed.map(
            (r) => html`<tr>
              ${columns.map((c) => {
                const cell = r[c];
                return html`<td class=${numeric[c] ? "num" : ""}>
                  ${isEmpty(cell) ? "—" : typeof cell === "number" ? measure(cell) : String(cell)}
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
