import { describe, expect, it } from "vitest";
import { parseModelJson, planSchema } from "./contract";
import { capabilitiesFixture, planningCatalog } from "./testing.test-support";

const schema = planSchema(planningCatalog, capabilitiesFixture);
const good = {
  summary: "Weekly orders and top SKUs",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders (7d)",
      span: 4,
      props: { unit: "orders" },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
    {
      id: "top_skus",
      type: "Collection",
      label: "Top SKUs",
      span: 8,
      props: { columns: ["sku", "units"] },
      binding: { capability: "orders_summary", arguments: { window: "7d" }, path: "rows" },
    },
    { id: "note", type: "Insight", label: "What this shows", props: { tone: "neutral" } },
  ],
};

describe("planSchema", () => {
  it("accepts a draft that uses declared types, allow-listed props and given capabilities; defaults span/priority/arguments", () => {
    const r = schema.safeParse(good);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nodes[2]?.span).toBe(6);
      expect(r.data.nodes[1]?.binding?.priority).toBe("P1");
    }
  });
  it("rejects an unknown type, an undeclared prop, an unknown capability, and a duplicate id — each named in the issue path", () => {
    const bad = {
      ...good,
      nodes: [
        { id: "a", type: "Gauge", label: "x", props: {} },
        {
          id: "b",
          type: "Metric",
          label: "x",
          props: { color: "red" },
          binding: { capability: "orders_summary", path: "" },
        },
        {
          id: "c",
          type: "Metric",
          label: "x",
          props: {},
          binding: { capability: "nope", path: "" },
        },
        { id: "c", type: "Insight", label: "x", props: {} },
      ],
    };
    const r = schema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      expect(msgs.some((m) => m.startsWith("nodes.0.type") && m.includes("Gauge"))).toBe(true);
      expect(msgs.some((m) => m.startsWith("nodes.1.props.color"))).toBe(true);
      expect(
        msgs.some((m) => m.startsWith("nodes.2.binding.capability") && m.includes("nope"))
      ).toBe(true);
      expect(msgs.some((m) => m.includes('duplicate node id "c"'))).toBe(true);
    }
  });
  it("enforces the entry's binding rule: required needs one, none forbids one", () => {
    const r = schema.safeParse({
      summary: "s",
      nodes: [
        { id: "m", type: "Metric", label: "x", props: {} },
        {
          id: "i",
          type: "Insight",
          label: "x",
          props: {},
          binding: { capability: "orders_summary", path: "" },
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      expect(msgs.some((m) => m.startsWith("nodes.0.binding") && m.includes("requires"))).toBe(
        true
      );
      expect(msgs.some((m) => m.startsWith("nodes.1.binding") && m.includes("does not bind"))).toBe(
        true
      );
    }
  });
  it("refuses ids that are not safe identifiers and a 25th node", () => {
    expect(
      schema.safeParse({
        summary: "s",
        nodes: [{ id: "Bad Id", type: "Insight", label: "x", props: {} }],
      }).success
    ).toBe(false);
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `n${i}`,
      type: "Insight",
      label: "x",
      props: {},
    }));
    expect(schema.safeParse({ summary: "s", nodes: many }).success).toBe(false);
  });
});

describe("parseModelJson", () => {
  it("strips a ```json fence, parses, and validates", () => {
    const r = parseModelJson(schema, `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
    expect(r.ok).toBe(true);
  });
  it("returns the parse error and a bounded raw excerpt, never throws", () => {
    const r = parseModelJson(schema, "not json {{{");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/invalid JSON/);
      expect(r.raw.length).toBeLessThanOrEqual(4000);
    }
    const r2 = parseModelJson(schema, JSON.stringify({ summary: "s", nodes: [] }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/nodes/);
  });
});
