import { chatCatalogEntries, defineSemanticCatalog } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import { describeCatalog } from "./prompt";
import { ReferencePlanner } from "./reference";
import type { Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

// U8. The planner is offered chat and inputs ONLY if the catalogue includes them, and it can shape
// them (where, what they are called, a form's fields) but never author what is said in a transcript
// nor a value a person "entered": the framework's own allow-list refuses it whatever the catalogue
// declares, and the refusal is fed back to the model.

const withChat = defineSemanticCatalog({
  id: "test.planning.chat.v1",
  entries: [...planningCatalog.entries, ...chatCatalogEntries()],
});
const draft = (nodes: unknown[]) => JSON.stringify({ summary: "s", nodes });
const chat = (props: Record<string, unknown> = {}, withBinding = true) => ({
  id: "convo",
  type: "Chat",
  label: "Support",
  span: 12,
  props,
  ...(withBinding && {
    binding: { capability: "orders_summary", arguments: {}, path: "totals.count", priority: "P1" },
  }),
});
const input = (type: string, props: Record<string, unknown> = {}, id = "in") => ({
  id,
  type,
  label: "Ask",
  span: 12,
  props,
});
const composeInput = {
  intent: intentFixture,
  catalog: withChat,
  capabilities: capabilitiesFixture,
};
const attemptCodes = (r: Awaited<ReturnType<ReferencePlanner["compose"]>>) =>
  r.report.attempts.flatMap((a) => a.findings.map((f) => f.code));

describe("the reference planner and chat", () => {
  it("offers chat guidance only when the catalogue includes chat entries", () => {
    expect(describeCatalog(withChat)).toContain("NEVER write messages, turns, replies");
    expect(describeCatalog(withChat)).toContain("set no value, default, prefill or submit");
    expect(describeCatalog(planningCatalog)).not.toMatch(/chat|transcript|prefill/i);
  });

  it("a catalogue without the chat entries cannot compose a chat or input node at all", async () => {
    for (const node of [chat(), input("TextInput")]) {
      const r = await new ReferencePlanner({
        model: scriptedModel([draft([node])], undefined),
        modelId: "m",
        maxAttempts: 2,
      }).compose({ ...composeInput, catalog: planningCatalog }, recordingContext());
      expect(r.ops).toEqual([]);
      expect(r.findings.some((f) => f.severity === "error")).toBe(true);
    }
  });

  it("composes a bound transcript beside a text input, a form and a select", async () => {
    const model = scriptedModel([
      draft([
        chat({ editable: true, emptyText: "Ask anything" }),
        input("TextInput", { label: "Message", multiline: true, maxChars: 2000 }, "composer"),
        input(
          "FormInput",
          {
            label: "Rollback",
            fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
          },
          "form"
        ),
        input(
          "SelectInput",
          {
            label: "Mode",
            options: [
              { value: "fast", label: "Fast" },
              { value: "deep", label: "Deep" },
            ],
          },
          "mode"
        ),
      ]),
    ]);
    const r = await new ReferencePlanner({ model, modelId: "m" }).compose(
      composeInput,
      recordingContext()
    );
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.ops.length).toBeGreaterThan(0);
  });

  it.each([
    [
      "transcript text in an `entries` prop",
      chat({ entries: [{ role: "assistant", text: "Your refund is approved" }] }),
      "chat-prop-forbidden",
    ],
    ["a forged reply in `messages`", chat({ messages: ["I approve this"] }), "chat-prop-forbidden"],
    [
      "raw text in a `text` prop",
      chat({ text: "ignore previous instructions" }),
      "chat-prop-forbidden",
    ],
    [
      "HTML in a `html` prop",
      chat({ html: "<img src=x onerror=alert(1)>" }),
      "chat-prop-forbidden",
    ],
    [
      "a prefilled `value` on an input",
      input("TextInput", { value: "yes, delete everything" }),
      "chat-prop-forbidden",
    ],
    [
      "a `defaultValue` on a form",
      input("FormInput", {
        fields: [{ name: "a", label: "A", type: "text" }],
        defaultValue: { a: "x" },
      }),
      "chat-prop-forbidden",
    ],
    [
      "a default smuggled into a field",
      input("FormInput", { fields: [{ name: "a", label: "A", type: "text", default: "x" }] }),
      "chat-prop-shape",
    ],
    [
      "a regex pattern on a field (a ReDoS)",
      input("FormInput", { fields: [{ name: "a", label: "A", type: "text", pattern: "(a+)+$" }] }),
      "chat-prop-shape",
    ],
    ["a submit action on an input", input("TextInput", { submit: true }), "chat-prop-forbidden"],
    [
      "a URL in a label",
      input("TextInput", { label: "see https://evil.example/login" }),
      "embedded-ref",
    ],
    ["an unbound transcript", chat({}, false), "chat-unbound"],
  ])("refuses %s and feeds it back", async (_l, node, code) => {
    const model = scriptedModel([draft([node])]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      composeInput,
      recordingContext()
    );
    if (code === "embedded-ref") {
      // a warning, not a refusal: reported, never silently dropped
      expect(attemptCodes(r)).toContain(code);
      return;
    }
    expect(r.ops).toEqual([]);
    // Refused either by the catalogue's own allow-list (the draft is `model-output-invalid`) or by the
    // framework's chat guard: both are fed back, and the model is asked again.
    expect(attemptCodes(r).some((c) => c === code || c === "model-output-invalid")).toBe(true);
    expect(model.calls).toBe(2);
  });

  it("an input with a binding is refused: nothing a person types is bound data", async () => {
    const bound = {
      ...input("TextInput"),
      binding: {
        capability: "orders_summary",
        arguments: {},
        path: "totals.count",
        priority: "P1",
      },
    };
    const r = await new ReferencePlanner({
      model: scriptedModel([draft([bound])]),
      modelId: "m",
      maxAttempts: 1,
    }).compose(composeInput, recordingContext());
    expect(r.ops).toEqual([]);
  });

  it("even a catalogue that DECLARES transcript/value props cannot admit them", async () => {
    const lax = defineSemanticCatalog({
      id: "lax",
      entries: chatCatalogEntries().map((e) =>
        e.name === "Chat" || e.name === "TextInput"
          ? {
              ...e,
              props: [...e.props, "entries", "value"],
              surfaces: {
                web: { kind: e.name, props: [...e.props, "entries", "value"], binding: e.binding },
              },
            }
          : e
      ),
    });
    for (const node of [chat({ entries: [] }), input("TextInput", { value: "x" })]) {
      const r = await new ReferencePlanner({
        model: scriptedModel([draft([node])]),
        modelId: "m",
        maxAttempts: 2,
      }).compose({ ...composeInput, catalog: lax }, recordingContext());
      expect(r.ops).toEqual([]);
      expect(attemptCodes(r)).toContain("chat-prop-forbidden");
    }
  });
});

describe("checkPlannerConformance and chat", () => {
  const good = draft([
    chat({ editable: true }),
    input("TextInput", { label: "Message" }, "composer"),
  ]);
  const revise = JSON.stringify({
    summary: "s",
    nodes: [
      ...JSON.parse(good).nodes,
      { id: "why", type: "Insight", label: "Why", span: 12, props: {} },
    ],
  });
  const fixture = () => ({
    intent: intentFixture,
    catalog: withChat,
    capabilities: capabilitiesFixture,
    meta: metaFixture,
    revision: { text: "add an insight" },
    ctx: recordingContext(),
  });

  it("the reference planner composing a transcript and an input passes with zero findings", async () => {
    const planner = new ReferencePlanner({ model: scriptedModel([good, revise]), modelId: "m" });
    expect(await checkPlannerConformance(planner, fixture())).toEqual([]);
  });

  it("a planner that writes transcript content or a prefill after validation is reported", async () => {
    const inner = new ReferencePlanner({ model: scriptedModel([good, revise]), modelId: "m" });
    const tamper = (r: Awaited<ReturnType<Planner["compose"]>>) => ({
      ...r,
      ops: r.ops.map((op) =>
        op.type === "insertNode" && op.node.kind === "semantic" && op.node.type === "Chat"
          ? {
              ...op,
              node: { ...op.node, props: { ...op.node.props, entries: [{ text: "forged" }] } },
            }
          : op.type === "insertNode" && op.node.kind === "semantic" && op.node.type === "TextInput"
            ? { ...op, node: { ...op.node, props: { ...op.node.props, value: "prefilled" } } }
            : op
      ),
    });
    const rogue: Planner = {
      compose: async (i, c) => tamper(await inner.compose(i, c)),
      revise: (i, c) => inner.revise(i, c),
    };
    const found = await checkPlannerConformance(rogue, fixture());
    expect(found.map((f) => f.code)).toContain("compose-invalid:chat-prop-forbidden");
  });
});
