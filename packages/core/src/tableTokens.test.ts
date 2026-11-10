import { describe, expect, it } from "vitest";
import { checkKindValue } from "./browser";
import {
  MAX_CELL_TOKENS,
  MAX_TOKEN_LABEL,
  TABLE_TOKEN,
  tableCellText,
  tableRowProblems,
} from "./tableRows";
import { TableValue } from "./values";

const tok = (id: string, label = id) => ({ id, label });
const withCell = (cell: unknown) => ({ columns: ["a", "b"], rows: [["x", cell]] });
const many = (n: number) => Array.from({ length: n }, (_, i) => tok(`t${i}`));

/** Both contracts must refuse with the SAME message, at the cell's path. */
function expectRefused(cell: unknown, message: string): void {
  const v = withCell(cell);
  const zod = TableValue.safeParse(v);
  expect(zod.success).toBe(false);
  const lite = checkKindValue("Table", v);
  expect(lite.ok).toBe(false);
  expect(lite).toEqual(
    checkKindValue("Table", v) // stable
  );
  const zodIssues = zod.success ? [] : zod.error.issues.map((i) => [i.path, i.message]);
  expect(zodIssues).toContainEqual([["rows", 0, 1], message]);
  expect(JSON.stringify(lite)).toContain(message);
}

describe("table token cells", () => {
  it("names the action type", () => expect(TABLE_TOKEN).toBe("TABLE_TOKEN"));

  it("accepts token cells (also empty and at the caps) without rowKeys, on both paths", () => {
    for (const cell of [
      { tokens: [] },
      { tokens: [tok("a", "Alpha"), tok("b.c:d-1", "Beta")] },
      { tokens: many(MAX_CELL_TOKENS) },
      { tokens: [tok("a", "x".repeat(MAX_TOKEN_LABEL))] },
    ]) {
      const v = withCell(cell);
      expect(TableValue.safeParse(v).success).toBe(true);
      expect(checkKindValue("Table", v).ok).toBe(true);
      expect(tableRowProblems(v)).toEqual([]);
    }
  });

  it.each([
    ["too many tokens", { tokens: many(MAX_CELL_TOKENS + 1) }, "a cell has at most 20 tokens"],
    [
      "a duplicate id",
      { tokens: [tok("a"), tok("a", "other")] },
      "token ids must be unique within a cell",
    ],
    ["a bad id", { tokens: [tok("bad id")] }, "a token id must be a short identifier"],
    ["an empty id", { tokens: [tok("")] }, "a token id must be a short identifier"],
    ["an empty label", { tokens: [tok("a", "")] }, "a token label is 1 to 80 characters"],
    [
      "an overlong label",
      { tokens: [tok("a", "x".repeat(MAX_TOKEN_LABEL + 1))] },
      "a token label is 1 to 80 characters",
    ],
    ["an unknown cell key", { tokens: [], extra: 1 }, "a token cell has only tokens"],
    [
      "an unknown token key",
      { tokens: [{ id: "a", label: "A", extra: 1 }] },
      "a token has only id and label",
    ],
  ])("refuses %s with one message on both paths", (_n, cell, message) => {
    expectRefused(cell, message);
    expect(tableRowProblems(withCell(cell)).map((p) => p.message)).toContain(message);
  });

  it("refuses a non-array tokens value, and a token missing its label, on both paths", () => {
    for (const cell of [{ tokens: "a" }, { tokens: { id: "a" } }, { tokens: [{ id: "a" }] }]) {
      const v = withCell(cell);
      expect(TableValue.safeParse(v).success).toBe(false);
      expect(checkKindValue("Table", v).ok).toBe(false);
    }
  });

  it("never echoes the offending value", () => {
    const secret = "SECRET-LABEL-VALUE";
    const v = withCell({ tokens: [{ id: "bad id SECRET", label: "", extra: secret }] });
    expect(JSON.stringify(tableRowProblems(v))).not.toContain("SECRET");
    expect(JSON.stringify(checkKindValue("Table", v))).not.toContain("SECRET");
  });

  it("reports each rule once per cell, at the cell's path", () => {
    const v = { columns: ["a"], rows: [["x"], [{ tokens: [tok("a"), tok("a")] }]] };
    expect(tableRowProblems(v)).toEqual([
      { path: ["rows", 1, 0], message: "token ids must be unique within a cell" },
    ]);
  });

  it("tableCellText joins labels with a comma and a space", () => {
    expect(tableCellText({ tokens: [tok("a", "Alpha"), tok("b", "Beta")] })).toBe("Alpha, Beta");
    expect(tableCellText({ tokens: [] })).toBe("");
    expect(tableCellText("s")).toBe("s");
    expect(tableCellText(3)).toBe("3");
    expect(tableCellText(null)).toBe("");
  });
});
