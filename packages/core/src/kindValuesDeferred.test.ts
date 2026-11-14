import { describe, expect, it } from "vitest";
import { CHAT_INPUT_KINDS, CHAT_KIND } from "./chatValue";
import { useChatContracts } from "./contractsChat";
import { useDiagramContracts } from "./contractsDiagram";
import { useMediaContracts } from "./contractsMedia";
import {
  FRAMEWORK_KINDS,
  checkKindValue,
  hasKindContract,
  installDeferredContracts,
  isFrameworkContractKind,
} from "./kindValues";
import { MEDIA_INPUT_KIND, MEDIA_KINDS } from "./mediaRef";

// The zod-free checker's chat, media and diagram contracts are DEFERRED so a browser bundle that
// draws none of those kinds does not carry them. This file deliberately does NOT import
// `deferredContracts.test-support`: each test below runs in the unloaded state first, so the
// file's order matters (loading is one-way for the module instance vitest gives this file).

const CHAT = { mode: "owner", entries: [] };
const IMAGE = { address: "sha256:ab", mediaType: "image/png" };
const DIAGRAM = { layout: "flow", nodes: [{ id: "a", label: "A" }], edges: [] };

describe("deferred value contracts (zod-free checker)", () => {
  it("FRAMEWORK_KINDS still names every chat and media kind (spelled out, not spread)", () => {
    expect(FRAMEWORK_KINDS).toEqual(
      expect.arrayContaining([...MEDIA_KINDS, MEDIA_INPUT_KIND, CHAT_KIND, ...CHAT_INPUT_KINDS])
    );
  });

  it("an unloaded deferred kind is REFUSED with a fixed finding, never passed (fail closed)", () => {
    for (const [kind, value, use] of [
      ["Chat", CHAT, "useChatContracts"],
      ["MultiSelectInput", { options: [], selected: [] }, "useChatContracts"],
      ["Image", IMAGE, "useMediaContracts"],
      ["Diagram", DIAGRAM, "useDiagramContracts"],
    ] as const) {
      expect(isFrameworkContractKind(kind), kind).toBe(true);
      expect(hasKindContract(kind), kind).toBe(true);
      const r = checkKindValue(kind, value);
      expect(r.ok, kind).toBe(false);
      if (!r.ok) {
        expect(r.finding.code).toBe("value-contract");
        expect(r.finding.severity).toBe("error");
        expect(r.finding.message).toBe(
          `value for kind "${kind}" cannot be checked: its contract is not loaded (call ${use}() from @loomwork/ui-core/browser)`
        );
      }
      // `undefined` is "not hydrated yet": it passes, loaded or not.
      expect(checkKindValue(kind, undefined).ok).toBe(true);
    }
  });

  it("a host contract cannot stand in for an unloaded framework kind", () => {
    const pass = { safeParse: () => ({ success: true as const }) };
    expect(checkKindValue("Chat", CHAT, { Chat: pass }).ok).toBe(false);
  });

  it("only a deferred kind can be installed: an always-loaded contract cannot be replaced", () => {
    expect(() => installDeferredContracts({ Table: () => "valid" })).toThrow(/not a deferred kind/);
    expect(() => installDeferredContracts({ Custom: () => "valid" })).toThrow(
      /not a deferred kind/
    );
  });

  it("once loaded, each kind checks its values (good passes, bad is refused by the contract)", () => {
    useChatContracts();
    useMediaContracts();
    useDiagramContracts();
    expect(checkKindValue("Chat", CHAT).ok).toBe(true);
    expect(checkKindValue("Image", IMAGE).ok).toBe(true);
    expect(checkKindValue("Diagram", DIAGRAM).ok).toBe(true);
    for (const [kind, bad] of [
      ["Chat", { entries: "nope" }],
      ["Image", { address: 1 }],
      ["Diagram", { layout: "flow", nodes: [], edges: [] }],
    ] as const) {
      const r = checkKindValue(kind, bad);
      expect(r.ok, kind).toBe(false);
      if (!r.ok) expect(r.finding.message).not.toMatch(/not loaded/);
    }
    // Idempotent: loading twice changes nothing.
    useChatContracts();
    expect(checkKindValue("Chat", CHAT).ok).toBe(true);
  });
});
