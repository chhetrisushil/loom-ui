import { describe, expect, it } from "vitest";
import {
  type A2UIRender,
  type A2UIView,
  formatValue,
  isBinding,
  isListChildren,
  nodeById,
  planView,
  resolveNodeProps,
  resolvePointer,
  resolveProp,
  rootNode,
} from "./plan.js";

describe("resolvePointer", () => {
  const doc = { a: { b: [10, 20] }, "x/y": 1, "m~n": 2, status: "ok" };

  it("returns the whole document for the empty pointer", () => {
    expect(resolvePointer(doc, "")).toBe(doc);
  });
  it("walks object keys", () => {
    expect(resolvePointer(doc, "/status")).toBe("ok");
    expect(resolvePointer(doc, "/a/b")).toEqual([10, 20]);
  });
  it("walks array indices", () => {
    expect(resolvePointer(doc, "/a/b/1")).toBe(20);
  });
  it("unescapes ~1 (/) and ~0 (~)", () => {
    expect(resolvePointer(doc, "/x~1y")).toBe(1);
    expect(resolvePointer(doc, "/m~0n")).toBe(2);
  });
  it("returns undefined for absent keys, bad indices, or non-objects", () => {
    expect(resolvePointer(doc, "/nope")).toBeUndefined();
    expect(resolvePointer(doc, "/a/b/9")).toBeUndefined();
    expect(resolvePointer(doc, "/status/x")).toBeUndefined();
    expect(resolvePointer(doc, "not-a-pointer")).toBeUndefined();
  });
  it("does not resolve inherited/prototype keys", () => {
    expect(resolvePointer({}, "/toString")).toBeUndefined();
  });
});

describe("isBinding / isListChildren", () => {
  it("recognizes a pure { path } binding", () => {
    expect(isBinding({ path: "/a" })).toBe(true);
    expect(isBinding({ path: "/a", componentId: "x" })).toBe(false); // that's a list template
    expect(isBinding("literal")).toBe(false);
    expect(isBinding(null)).toBe(false);
  });
  it("recognizes a list children template", () => {
    expect(isListChildren({ path: "/rows", componentId: "row" })).toBe(true);
    expect(isListChildren({ path: "/rows" })).toBe(false);
  });
});

describe("resolveProp", () => {
  const data = { status: "running", n: 5 };
  it("passes literals through", () => {
    expect(resolveProp("hi", data)).toBe("hi");
    expect(resolveProp(42, data)).toBe(42);
  });
  it("resolves a binding against the data model", () => {
    expect(resolveProp({ path: "/status" }, data)).toBe("running");
  });
  it("prefers the list-element scope when the relative path resolves there", () => {
    expect(resolveProp({ path: "/label" }, data, { label: "Row A" })).toBe("Row A");
  });
  it("falls back to the root data model when the scope lacks the path", () => {
    expect(resolveProp({ path: "/status" }, data, { label: "Row A" })).toBe("running");
  });
});

describe("tree helpers", () => {
  const view: A2UIView = {
    catalogId: "genui.widgets.v1",
    nodes: [
      { id: "root", component: "Column", children: ["title", "val"] },
      { id: "title", component: "Text", text: "Revenue" },
      { id: "val", component: "Text", text: { path: "/value" } },
    ],
  };

  it("finds nodes by id and the root", () => {
    expect(nodeById(view, "title")?.component).toBe("Text");
    expect(rootNode(view)?.id).toBe("root");
    expect(nodeById(view, "missing")).toBeUndefined();
  });

  it("resolves a node's props, excluding structural keys", () => {
    const props = resolveNodeProps(nodeById(view, "val")!, { value: 99 });
    expect(props).toEqual({ text: 99 });
    // id/component/children never appear as props.
    const rootProps = resolveNodeProps(rootNode(view)!, {});
    expect(rootProps).toEqual({});
  });
});

describe("formatValue", () => {
  it("passes strings, stringifies primitives, JSON-encodes objects, empties nullish", () => {
    expect(formatValue("hi")).toBe("hi");
    expect(formatValue(42)).toBe("42");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(null)).toBe("");
    expect(formatValue(undefined)).toBe("");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("planView", () => {
  it("plans an empty view when the root is missing", () => {
    expect(planView({ nodes: [] }, {})).toEqual({ kind: "empty" });
  });

  it("plans a column of text nodes with literal and bound props", () => {
    const view: A2UIView = {
      nodes: [
        { id: "root", component: "Column", children: ["label", "value"] },
        { id: "label", component: "Text", text: "Revenue" },
        { id: "value", component: "Text", text: { path: "/value" } },
      ],
    };
    expect(planView(view, { value: 4200 })).toEqual({
      kind: "column",
      children: [
        { kind: "text", text: "Revenue" },
        { kind: "text", text: "4200" },
      ],
    });
  });

  it("plans a data-bound List, scoping relative bindings to each element", () => {
    const view: A2UIView = {
      nodes: [
        { id: "root", component: "List", children: { path: "/rows", componentId: "row" } },
        { id: "row", component: "Text", text: { path: "/name" } },
      ],
    };
    const plan = planView(view, { rows: [{ name: "Alpha" }, { name: "Beta" }] }) as Extract<
      A2UIRender,
      { kind: "list" }
    >;
    expect(plan.kind).toBe("list");
    expect(plan.children).toEqual([
      { kind: "text", text: "Alpha" },
      { kind: "text", text: "Beta" },
    ]);
  });

  it("plans an empty list when the bound array is absent", () => {
    const view: A2UIView = {
      nodes: [
        { id: "root", component: "List", children: { path: "/missing", componentId: "row" } },
        { id: "row", component: "Text", text: "x" },
      ],
    };
    expect(planView(view, {})).toEqual({ kind: "list", children: [] });
  });

  it("plans a button carrying its action and the element scope as context", () => {
    const view: A2UIView = {
      nodes: [
        { id: "root", component: "List", children: { path: "/items", componentId: "btn" } },
        { id: "btn", component: "Button", label: { path: "/name" }, action: "pick" },
      ],
    };
    const plan = planView(view, { items: [{ name: "A", id: 7 }] }) as Extract<
      A2UIRender,
      { kind: "list" }
    >;
    expect(plan.children[0]).toEqual({
      kind: "button",
      label: "A",
      action: "pick",
      context: { name: "A", id: 7 },
    });
  });

  it("plans a badge with its tone", () => {
    const view: A2UIView = {
      nodes: [{ id: "root", component: "Badge", label: "LIVE", tone: "ok" }],
    };
    expect(planView(view, {})).toEqual({ kind: "badge", label: "LIVE", tone: "ok" });
  });

  it("plans an unknown component rather than throwing", () => {
    const view: A2UIView = { nodes: [{ id: "root", component: "Frobnicate" }] };
    expect(planView(view, {})).toEqual({ kind: "unknown", component: "Frobnicate" });
  });

  it("drops a child reference that points at a missing node", () => {
    const view: A2UIView = {
      nodes: [
        { id: "root", component: "Column", children: ["ghost", "real"] },
        { id: "real", component: "Text", text: "here" },
      ],
    };
    expect(planView(view, {})).toEqual({
      kind: "column",
      children: [{ kind: "text", text: "here" }],
    });
  });

  it("guards against a reference cycle instead of recursing forever", () => {
    const view: A2UIView = {
      nodes: [
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "Column", children: ["root"] },
      ],
    };
    // root → a → root: the second visit to root is pruned to empty.
    expect(planView(view, {})).toEqual({
      kind: "column",
      children: [{ kind: "column", children: [{ kind: "empty" }] }],
    });
  });
});
