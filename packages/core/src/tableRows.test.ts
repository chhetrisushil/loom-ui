import { describe, expect, it } from "vitest";
import { checkKindValue } from "./browser";
import { TABLE_ROW_ACTION, tableRowProblems } from "./tableRows";
import { TableValue } from "./values";

const base = { columns: ["Name"], rows: [["a"], ["b"]] };
const open = { id: "open", label: "Open", primary: true };
const del = { id: "delete", label: "Delete", destructive: true };

describe("table row actions: the contract", () => {
  it("names the action type", () => expect(TABLE_ROW_ACTION).toBe("TABLE_ROW_ACTION"));

  it("accepts a table without keys or actions, with keys alone, and with keys and actions", () => {
    for (const v of [
      base,
      { ...base, rowKeys: ["r1", "r2"] },
      { ...base, rowKeys: ["r1", "r2"], rowActions: [[open, del], []] },
    ]) {
      expect(TableValue.safeParse(v).success).toBe(true);
      expect(checkKindValue("Table", v).ok).toBe(true);
      expect(tableRowProblems(v)).toEqual([]);
    }
  });

  it.each([
    ["a key per row", { ...base, rowKeys: ["r1"] }, "rowKeys must have one key per row"],
    ["unique keys", { ...base, rowKeys: ["r1", "r1"] }, "rowKeys must be unique"],
    ["a plain key", { ...base, rowKeys: ["r1", "bad key"] }, "rowKeys must be short identifiers"],
    ["keys for actions", { ...base, rowActions: [[], []] }, "rowActions need rowKeys"],
    [
      "a list per row",
      { ...base, rowKeys: ["r1", "r2"], rowActions: [[]] },
      "rowActions must have one list per row",
    ],
    [
      "at most four",
      {
        ...base,
        rowKeys: ["r1", "r2"],
        rowActions: [
          [open, del, { id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
          [],
        ],
      },
      "a row has at most 4 actions",
    ],
    [
      "one primary",
      {
        ...base,
        rowKeys: ["r1", "r2"],
        rowActions: [[open, { id: "edit", label: "Edit", primary: true }], []],
      },
      "a row has at most one primary action",
    ],
    [
      "unique ids",
      { ...base, rowKeys: ["r1", "r2"], rowActions: [[open, { id: "open", label: "Again" }], []] },
      "action ids must be unique within a row",
    ],
    [
      "a plain id",
      { ...base, rowKeys: ["r1", "r2"], rowActions: [[{ id: "Open!", label: "Open" }], []] },
      "an action id must be lower-case words",
    ],
    [
      "a short label",
      { ...base, rowKeys: ["r1", "r2"], rowActions: [[{ id: "open", label: "" }], []] },
      "an action label is 1 to 40 characters",
    ],
    [
      "no destructive primary",
      {
        ...base,
        rowKeys: ["r1", "r2"],
        rowActions: [[{ id: "delete", label: "Delete", primary: true, destructive: true }], []],
      },
      "a destructive action cannot be primary",
    ],
  ])("refuses %s", (_name, v, message) => {
    expect(tableRowProblems(v).map((p) => p.message)).toContain(message);
    expect(TableValue.safeParse(v).success).toBe(false);
    const checked = checkKindValue("Table", v);
    expect(checked.ok).toBe(false);
  });

  it("the zod contract and the zod-free checker say the same thing (same messages, same paths)", () => {
    const bad = { ...base, rowKeys: ["r1", "r1"], rowActions: [[open, open], []] };
    const zod = TableValue.safeParse(bad);
    const messages = zod.success ? [] : zod.error.issues.map((i) => i.message);
    expect(messages).toEqual(tableRowProblems(bad).map((p) => p.message));
  });
});
