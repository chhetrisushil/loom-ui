import { describe, expect, it } from "vitest";
import { type ChildSpec, applyPlacement } from "./tree";

// IR 2.1.0 placement, unit-level: `applyPlacement` must write the exact `gridColumn` /
// `gridRow` strings loom's React renderer's `cellStyle` writes (plugins/renderer-react's
// `renderContainer.tsx`) — carried over from Task 5's review, which shipped the formula on
// blueprint-shaped fixtures (`placedV` in `recompose.test.ts`) but never pinned the raw strings
// for a cell that sets row, rowSpan AND column together, or for a column-only / row-only cell in
// isolation.

const spec = (over: Partial<ChildSpec>): ChildSpec => ({
  node: over.node as never,
  span: 1,
  ...over,
});

describe("applyPlacement — exact grid-line strings (parity with loom React's cellStyle)", () => {
  it("row, rowSpan and column all set: both lines are anchored", () => {
    const el = document.createElement("div");
    applyPlacement(el, spec({ span: 4, row: 2, rowSpan: 3, column: 5 }), true);
    expect(el.style.gridColumn).toBe("5 / span 4");
    expect(el.style.gridRow).toBe("2 / span 3");
  });

  it("column only: the column is anchored, the row is a bare span from the cell's own span", () => {
    const el = document.createElement("div");
    applyPlacement(el, spec({ span: 2, column: 3 }), true);
    expect(el.style.gridColumn).toBe("3 / span 2");
    expect(el.style.gridRow).toBe("");
  });

  it("row only: the row is anchored, the column falls back to a bare span (placed, so span 1 still writes)", () => {
    const el = document.createElement("div");
    applyPlacement(el, spec({ span: 1, row: 4 }), true);
    expect(el.style.gridColumn).toBe("span 1");
    expect(el.style.gridRow).toBe("4 / span 1");
  });
});
