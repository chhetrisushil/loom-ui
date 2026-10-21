import {
  TABLE_ROW_ACTION,
  type TableCell,
  type TableValue,
  tableColumnFormat,
  tableColumnLabel,
} from "@loom-ui/core/browser";
import { pluralForms } from "@loom-ui/core/messages";
import { type TemplateResult, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { describeValue } from "../a11y";
import { cssomStyle } from "../cssomStyle";
import { measure } from "../format";
import { formattingLocale } from "../i18n";
import { tPlural } from "../plural";
import { say } from "../say";
import { LuWidget } from "./base";
import { type DispatchResult, dispatch, failureText } from "./chatShared";
import { VirtualRows, type VirtualizeOptions, padRow, resolveVirtualize } from "./virtual";

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
export class LuTable extends LuWidget {
  readonly kind = "Table";

  @state() private sortCol: number | null = null;
  @state() private sortDir: 1 | -1 = -1;
  @state() private visibleRows = INITIAL_ROWS;
  /** Row keys with an action in flight (their buttons are off until the host answers). */
  @state() private busy: ReadonlySet<string> = new Set();
  /** The last refused or failed answer, in the widget's own fixed words; cleared by the next action. */
  @state() private failure: DispatchResult | null = null;
  /** U17: windowed rendering (see `./virtual`). Off by default; set by `createLitRegistry({ virtualize })`. */
  @property({ attribute: false }) virtualize?: boolean | VirtualizeOptions;
  private readonly rowsWindow = new VirtualRows(this);

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
    tbody.virtual td {
      box-sizing: border-box;
      height: var(--lu-row-h);
      padding-block: 0;
    }
    td.row-actions {
      white-space: nowrap;
      text-align: end;
    }
    td.row-actions button,
    .cell-link {
      all: unset;
      cursor: pointer;
      font: inherit;
      color: var(--lu-accent, #6366f1);
      padding: 2px 6px;
      border-radius: var(--lu-radius, 6px);
    }
    .cell-link {
      color: inherit;
      text-decoration: underline;
    }
    td.row-actions button.danger {
      color: var(--lu-status-critical, #f87171);
    }
    button[data-row-action]:disabled {
      color: var(--lu-text-dim, #8b949e);
      cursor: default;
    }
    button[data-row-action]:focus-visible {
      outline: 2px solid var(--lu-accent, #6366f1);
      outline-offset: 1px;
    }
    .status {
      padding: 6px 10px;
      min-height: 1em;
      font-size: 11px;
      color: var(--lu-status-critical, #f87171);
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
    let order = v.rows.map((_, i) => i);
    const col = this.sortCol;
    if (col !== null && col < labels.length) {
      const dir = this.sortDir;
      order = [...order].sort((i, j) => {
        const x = at(v.rows[i] as readonly TableCell[], col);
        const y = at(v.rows[j] as readonly TableCell[], col);
        if (x === null || y === null) return compareCells(x, y);
        return compareCells(x, y) * dir;
      });
    }
    const total = order.length;
    const cols = labels.length + (Array.isArray(v.rowActions) ? 1 : 0);
    const virt = resolveVirtualize(this.virtualize);
    const win = this.rowsWindow.plan(total, virt);
    const shown = win === undefined ? Math.min(this.visibleRows, total) : total;
    const windowed =
      win !== undefined
        ? order.slice(win.start, win.end)
        : shown < total
          ? order.slice(0, shown)
          : order;
    return html`<table aria-rowcount=${win !== undefined ? total + 1 : nothing}>
        <caption class="sr-only">${describeValue("Table", v, this.title_)}</caption>
        <thead>
          <tr aria-rowindex=${win !== undefined ? 1 : nothing}>
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
            ${!Array.isArray(v.rowActions) ? nothing : html`<th class="actions"><span class="sr-only">${say("lu.table.actions")}</span></th>`}
          </tr>
        </thead>
        <tbody class=${win !== undefined ? "virtual" : ""} ${cssomStyle(win !== undefined && virt ? { "--lu-row-h": `${virt.rowHeight}px` } : {})}>
          ${win !== undefined ? padRow(win.padTop, cols) : nothing}
          ${repeat(
            windowed,
            (ri) => (Array.isArray(v.rowKeys) ? (v.rowKeys[ri] ?? ri) : ri),
            (ri, i) => {
              const r = v.rows[ri] as readonly TableCell[];
              const key = Array.isArray(v.rowKeys) ? v.rowKeys[ri] : undefined;
              const rawActs = Array.isArray(v.rowActions) ? v.rowActions[ri] : undefined;
              const acts = Array.isArray(rawActs) ? rawActs : [];
              const c0 = at(r, 0);
              const shownFirst =
                c0 === null ? "" : typeof c0 === "number" ? measure(c0, formats[0]) : c0;
              const first = shownFirst.trim() === "" ? (key ?? String(ri + 1)) : shownFirst;
              const rowBusy = key !== undefined && this.busy.has(key);
              const primary = acts.find((a) => a.primary === true);
              const button = (
                a: (typeof acts)[number],
                cls: string,
                key: string,
                body: unknown
              ): TemplateResult =>
                html`<button
                type="button"
                class=${cls}
                data-row-action=${a.id}
                aria-label=${say("lu.table.rowAction", { label: a.label, row: first })}
                ?disabled=${this.onAction === undefined || rowBusy}
                @click=${() => this.rowAction(a.id, key)}
              >
                ${body}
              </button>`;
              return html`<tr aria-rowindex=${win !== undefined ? win.start + i + 2 : nothing}>
              ${labels.map((_, ci) => {
                const c = at(r, ci);
                const text = c === null ? "—" : typeof c === "number" ? measure(c, formats[ci]) : c;
                return html`<td class=${numeric[ci] ? "num" : ""}>
                  ${
                    ci === 0 && primary !== undefined && key !== undefined
                      ? button(primary, "cell-link", key, text)
                      : text
                  }
                </td>`;
              })}
              ${
                !Array.isArray(v.rowActions)
                  ? nothing
                  : html`<td class="row-actions">
                    ${key === undefined ? nothing : acts.map((a) => button(a, a.destructive === true ? "danger" : "", key, a.label))}
                  </td>`
              }
            </tr>`;
            }
          )}
          ${win !== undefined ? padRow(win.padBottom, cols) : nothing}
        </tbody>
      </table>
      <div class="status" role="status" ?data-error=${this.failure !== null}>${this.failure === null ? "" : failureText(this.failure)}</div>
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

  private async rowAction(action: string, rowKey: string): Promise<void> {
    if (this.busy.has(rowKey)) return;
    this.busy = new Set(this.busy).add(rowKey);
    this.failure = null;
    const result = await dispatch(this.onAction, {
      type: TABLE_ROW_ACTION,
      widgetId: this.widget.id,
      payload: { action, rowKey },
    });
    const left = new Set(this.busy);
    left.delete(rowKey);
    this.busy = left;
    this.failure = result === "ok" ? null : result;
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
    if (resolveVirtualize(this.virtualize) !== undefined) this.rowsWindow.reset();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-table": LuTable;
  }
}
