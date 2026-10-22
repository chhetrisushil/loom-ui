import { describe, expect, it } from "vitest";
import {
  CHAT_KINDS,
  MAX_CHAT_ENTRIES,
  MAX_CHAT_PARTS,
  MAX_CHAT_TEXT,
  MAX_MULTI_OPTIONS,
  chatValueIssues,
  isChatValue,
  multiSelectValueIssues,
} from "./chatValue";
import { checkKindValue as liteCheck } from "./kindValues";
import { checkKindValue as zodCheck } from "./values";

const text = (t: string) => [{ type: "text" as const, text: t }];
const entry = (over: Record<string, unknown> = {}) => ({
  id: "t1.user",
  turn: 1,
  role: "user",
  status: "complete",
  parts: text("hello"),
  ...over,
});
const value = (entries: unknown[] = [entry()], more: Record<string, unknown> = {}) => ({
  entries,
  ...more,
});

describe("the ChatValue contract", () => {
  it("accepts a full, well-formed transcript", () => {
    const v = value(
      [
        entry({ asker: { actor: "a", tenant: "t" }, cursor: "0.4", at: 1 }),
        entry({
          id: "t1.assistant",
          role: "assistant",
          status: "failed",
          reason: "model-error",
          errorId: "err-1",
          parts: [{ type: "media", ref: { address: "sha256:abc123", mediaType: "image/png" } }],
          tools: [{ name: "search", status: "done" }],
        }),
        entry({ id: "t2.user", turn: 2, editOf: 1 }),
        entry({ id: "t3.assistant", turn: 3, role: "assistant", status: "streaming" }),
      ],
      { viewer: { actor: "a", tenant: "t" }, older: "0.1", state: "open", running: true }
    );
    expect(chatValueIssues(v)).toEqual([]);
    expect(isChatValue(v)).toBe(true);
  });

  it("is a framework kind on BOTH checkers with the same verdict", () => {
    for (const bad of [
      value([entry({ id: "x y" })]),
      null,
      5,
      { entries: "no" },
      value([entry({ extra: 1 })]),
    ]) {
      const a = zodCheck("Chat", bad);
      const b = liteCheck("Chat", bad);
      expect(a.ok).toBe(false);
      expect(b).toEqual(a);
    }
    expect(CHAT_KINDS).toEqual([
      "Chat",
      "TextInput",
      "FormInput",
      "SelectInput",
      "MultiSelectInput",
    ]);
    // A SelectInput may be bound to its CURRENT value (a string); the other inputs stay static.
    expect(liteCheck("SelectInput", "b")).toEqual({ ok: true });
    expect(zodCheck("SelectInput", "b")).toEqual({ ok: true });
    for (const bad of [1, {}, ["a"], null]) {
      expect(liteCheck("SelectInput", bad).ok).toBe(false);
      expect(zodCheck("SelectInput", bad).ok).toBe(false);
    }
    // A MultiSelectInput MUST bind its options and choice; both checkers agree.
    const multi = { options: [{ value: "a", label: "A" }], selected: ["a"] };
    expect(liteCheck("MultiSelectInput", multi)).toEqual({ ok: true });
    expect(zodCheck("MultiSelectInput", multi)).toEqual({ ok: true });
    for (const bad of ["a", { options: [], selected: ["z"] }]) {
      const a = zodCheck("MultiSelectInput", bad);
      expect(a.ok).toBe(false);
      expect(liteCheck("MultiSelectInput", bad)).toEqual(a);
    }
    for (const k of ["TextInput", "FormInput", "SelectInput"]) {
      expect(liteCheck(k, undefined)).toEqual({ ok: true });
      if (k === "SelectInput") continue;
      expect(liteCheck(k, "typed text").ok).toBe(false); // an input is static: a value reaching it is a defect
    }
  });

  it("a RESTRICTED entry is a bare placeholder: content, tools, reason, error id, edit ref are all refused", () => {
    const restricted = { id: "t1.assistant", turn: 1, role: "assistant", status: "restricted" };
    expect(isChatValue(value([restricted]))).toBe(true);
    expect(
      isChatValue(value([{ ...restricted, asker: { actor: "a" }, cursor: "0.2", at: 3 }]))
    ).toBe(true);
    for (const extra of [
      { parts: text("secret") },
      { parts: [] },
      { tools: [{ name: "db", status: "done" }] },
      { reason: "denied" },
      { errorId: "e1" },
      { editOf: 1 },
    ])
      expect(
        isChatValue(value([{ ...restricted, turn: 2, id: "t2.assistant", ...extra }])),
        JSON.stringify(extra)
      ).toBe(false);
  });

  it("is STRICT: a field the contract does not name cannot ride along (classes, execution ids, html)", () => {
    for (const k of ["classes", "executionId", "turnExecutionId", "html", "text"])
      expect(isChatValue(value([entry({ [k]: "x" })])), k).toBe(false);
    expect(isChatValue(value([entry()], { sneaky: 1 }))).toBe(false);
    expect(isChatValue(value([entry({ parts: [{ type: "text", text: "a", html: "<b>" }] })]))).toBe(
      false
    );
    expect(isChatValue(value([entry({ asker: { actor: "a", role: "admin" } })]))).toBe(false);
  });

  it("refuses duplicate ids, bad enums, only assistants stream, an edit must point backwards", () => {
    expect(isChatValue(value([entry(), entry()]))).toBe(false);
    expect(isChatValue(value([entry({ role: "bot" })]))).toBe(false);
    expect(isChatValue(value([entry({ status: "weird" })]))).toBe(false);
    expect(isChatValue(value([entry({ status: "streaming" })]))).toBe(false);
    expect(isChatValue(value([entry({ turn: 2, id: "t2.user", editOf: 2 })]))).toBe(false);
    expect(isChatValue(value([entry({ cursor: "../x" })]))).toBe(false);
    expect(isChatValue(value([entry({ reason: "Model Error: boom at db.internal" })]))).toBe(false); // free text is not a reason
  });

  it("is bounded: entries, parts, text, tools", () => {
    const many = Array.from({ length: MAX_CHAT_ENTRIES + 1 }, (_, i) =>
      entry({ id: `t${i + 1}.user`, turn: i + 1 })
    );
    expect(isChatValue(value(many.slice(0, MAX_CHAT_ENTRIES)))).toBe(true);
    expect(isChatValue(value(many))).toBe(false);
    expect(
      isChatValue(
        value([entry({ parts: Array.from({ length: MAX_CHAT_PARTS + 1 }, () => text("a")[0]) })])
      )
    ).toBe(false);
    expect(isChatValue(value([entry({ parts: text("a".repeat(MAX_CHAT_TEXT + 1)) })]))).toBe(false);
    expect(
      isChatValue(
        value([entry({ tools: Array.from({ length: 17 }, () => ({ name: "t", status: "done" })) })])
      )
    ).toBe(false);
  });

  it("every message is value-free: it never echoes what it checked", () => {
    const secret = "SECRET-DO-NOT-ECHO";
    const issues = chatValueIssues(
      value([
        entry({
          id: secret,
          role: secret,
          status: secret,
          reason: secret,
          errorId: secret,
          cursor: secret,
          parts: [{ type: secret }],
        }),
      ])
    );
    expect(issues.length).toBeGreaterThan(3);
    expect(JSON.stringify(issues)).not.toContain(secret);
    expect(JSON.stringify(zodCheck("Chat", value([entry({ id: secret })])))).not.toContain(secret);
  });

  it("never throws and stays small on hostile values", () => {
    const cyc: Record<string, unknown> = { entries: [] };
    cyc.self = cyc;
    for (const v of [
      cyc,
      Object.create(null),
      [],
      new Map(),
      { entries: [null, 1, "x", [], {}] },
      JSON.parse('{"__proto__":{"entries":[]},"entries":[]}'),
    ])
      expect(() => chatValueIssues(v)).not.toThrow();
    expect(
      chatValueIssues({ entries: Array.from({ length: 500 }, () => null) }).length
    ).toBeLessThanOrEqual(20);
  });
});

describe("multiSelectValueIssues", () => {
  const ok = {
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta", hint: "processing" },
    ],
    selected: ["b"],
  };
  it("accepts a value whose selection is among its options", () => {
    expect(multiSelectValueIssues(ok)).toEqual([]);
    expect(multiSelectValueIssues({ ...ok, selected: [], note: "Showing some" })).toEqual([]);
  });
  it("refuses a non-object, a stray field, and missing lists", () => {
    expect(multiSelectValueIssues("a")).toEqual([
      { path: [], message: "Expected a multi-select value" },
    ]);
    expect(multiSelectValueIssues({ ...ok, html: "<b>" })).toContainEqual({
      path: [],
      message: "unexpected field",
    });
    expect(multiSelectValueIssues({ selected: [] })).toContainEqual({
      path: ["options"],
      message: "options is required",
    });
    expect(multiSelectValueIssues({ options: [] })).toContainEqual({
      path: ["selected"],
      message: "selected is required",
    });
  });
  it("refuses bad options: duplicates, control characters, empty or long labels, long hints, extra fields", () => {
    const bad = (o: unknown) => multiSelectValueIssues({ options: [o], selected: [] });
    expect(
      multiSelectValueIssues({ options: [ok.options[0], ok.options[0]], selected: [] })
    ).toContainEqual({ path: ["options", 1, "value"], message: "option values are unique" });
    expect(bad({ value: "a\u0007", label: "x" })).toContainEqual({
      path: ["options", 0, "value"],
      message: "an option value is short text without control characters",
    });
    expect(bad({ value: "a", label: "" })).toContainEqual({
      path: ["options", 0, "label"],
      message: "an option label is short text",
    });
    expect(bad({ value: "a", label: "x", hint: "h".repeat(41) })).toContainEqual({
      path: ["options", 0, "hint"],
      message: "a hint is short text",
    });
    expect(bad({ value: "a", label: "x", href: "y" })).toContainEqual({
      path: ["options", 0],
      message: "unexpected field",
    });
  });
  it("refuses a selection outside the options, a repeat, and more than the limits", () => {
    expect(multiSelectValueIssues({ ...ok, selected: ["z"] })).toContainEqual({
      path: ["selected", 0],
      message: "a selected value is one of the options",
    });
    expect(multiSelectValueIssues({ ...ok, selected: ["a", "a"] })).toContainEqual({
      path: ["selected", 1],
      message: "selected values are unique",
    });
    const many = Array.from({ length: MAX_MULTI_OPTIONS + 1 }, (_, i) => ({
      value: `v${i}`,
      label: "x",
    }));
    expect(multiSelectValueIssues({ options: many, selected: [] })).toContainEqual({
      path: ["options"],
      message: "at most 500 options",
    });
    const hundred = many.slice(0, 101);
    expect(
      multiSelectValueIssues({ options: hundred, selected: hundred.map((o) => o.value) })
    ).toContainEqual({ path: ["selected"], message: "at most 100 selected" });
    expect(multiSelectValueIssues({ ...ok, note: "" })).toContainEqual({
      path: ["note"],
      message: "note is short text",
    });
  });
});
