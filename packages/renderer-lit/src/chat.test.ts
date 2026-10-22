import {
  type ContainerNode,
  type SemanticNode,
  chatCatalogEntries,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { builtinCatalog, catalogCoverage, customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it, vi } from "vitest";
import { chatKindContracts, createChatLitRegistry, registerChatWidgets } from "./chat";
import { createLitRegistry } from "./dom/litRegistry";
import "./register";

describe("the opt-in chat entry", () => {
  it("registers exactly the chat kinds on top of the default registry, and keeps loom's built-ins covered", () => {
    const reg = createChatLitRegistry();
    for (const k of ["Chat", "TextInput", "FormInput", "SelectInput", "MultiSelectInput"])
      expect(reg.has(k)).toBe(true);
    expect(catalogCoverage(builtinCatalog, reg).missing).toEqual([]);
    expect(chatKindContracts.map((c) => c.kind).sort()).toEqual([
      "Chat",
      "FormInput",
      "MultiSelectInput",
      "SelectInput",
      "TextInput",
    ]);
    expect(registerChatWidgets(createLitRegistry())).toBeDefined();
  });

  it("the standard chat entries compile clean against the chat registry (no findings)", () => {
    const catalog = defineSemanticCatalog({ id: "chat.v1", entries: chatCatalogEntries() });
    const g = genesis({
      experienceId: "c",
      intent: { objective: "chat", source: "user" },
      meta: { author: "t", createdAt: "2026-10-09T00:00:00Z", sourceKind: "prompt" },
    });
    const props: Record<string, Record<string, unknown>> = {
      Chat: {},
      TextInput: {},
      FormInput: { fields: [{ name: "a", label: "A", type: "text" }] },
      SelectInput: { options: [{ value: "a", label: "A" }] },
      MultiSelectInput: {},
    };
    const children: SemanticNode[] = catalog.entries.map((e, i) => ({
      id: `n${i}`,
      order: String.fromCharCode(65 + i),
      kind: "semantic",
      type: e.name,
      typeVersion: "1.1.0",
      span: 6,
      props: props[e.name] ?? {},
      ...(["Chat", "MultiSelectInput"].includes(e.name) && {
        binding: { handle: "h", priority: "P1" as const },
      }),
    }));
    const providers = {
      h: {
        handle: "h",
        executionGraph: [],
        reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
        outputShapeHash: "sha256:o",
        cachePolicy: { ttlSeconds: 60, scope: "global" },
      },
    };
    const r = compile(
      { ...g, root: { ...(g.root as ContainerNode), children }, providers: providers as never },
      {
        surface: "web",
        catalog,
        hydrationProjectionId: "hydration",
        hydrationProjectionVersion: "1.0.0",
      }
    );
    expect(r.findings).toEqual([]);
  });
});

describe("the default registry and the chat kinds (no chat entry loaded)", () => {
  it("draws one fixed placeholder, never a value, a title or a prop, and warns once how to fix it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = createLitRegistry();
    const host = document.createElement("div");
    document.body.appendChild(host);
    for (const kind of ["Chat", "TextInput"]) {
      reg.get(kind)?.(host, {
        widget: customWidget$({
          kind,
          id: kind,
          title: "SECRETTITLE",
          props: { label: "SECRETLABEL" },
        }),
        value: undefined,
      });
    }
    await new Promise((r) => setTimeout(r, 10));
    const els = [...host.querySelectorAll("lu-chat-missing")] as HTMLElement[];
    expect(els).toHaveLength(2);
    for (const el of els) {
      const t = el.shadowRoot?.textContent ?? "";
      expect(t).toContain("Chat renderer not loaded");
      expect(t).not.toContain("SECRET");
    }
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("createChatLitRegistry"))
    ).toHaveLength(1);
    warn.mockRestore();
    host.remove();
  });
});
