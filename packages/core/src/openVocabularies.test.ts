import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WELL_KNOWN_SURFACES, defineSemanticCatalog, validateExperience } from "./catalog";
import { compile } from "./compile";
import { genesis } from "./experience";
import { checkKindValue as checkBrowser, hasKindContract as hasBrowser } from "./kindValues";
import type { SemanticNode } from "./node";
import { checkKindValue, hasKindContract } from "./values";

// U13: the surface and kind-contract vocabularies are OPEN. A host names its own surface and its
// own kinds' value contracts without forking; the framework's contracts stay the framework's.

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const gauge = z.object({ level: z.number() });
const catalog = defineSemanticCatalog({
  id: "voice.v1",
  entries: [
    {
      name: "Gauge",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: {
        voice: { kind: "SpokenGauge", props: [], binding: "required" },
        web: { kind: "MetricCard" },
      },
    },
  ],
  valueContracts: { SpokenGauge: gauge },
});
const node = (over: Partial<SemanticNode> = {}): SemanticNode => ({
  id: "g",
  order: "a",
  kind: "semantic",
  type: "Gauge",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle: "h", priority: "P1" },
  ...over,
});
const provider = (outputCheck?: "contract") => ({
  handle: "h",
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
  outputShapeHash: "sha256:o",
  cachePolicy: { ttlSeconds: 60, scope: "global" as const },
  ...(outputCheck !== undefined && { outputCheck }),
});
const exp = (outputCheck?: "contract") => {
  const g = genesis({ experienceId: "e", intent: { objective: "x", source: "user" }, meta });
  return { ...g, root: { ...g.root, children: [node()] }, providers: { h: provider(outputCheck) } };
};
const opts = {
  catalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
};

describe("open surface vocabulary", () => {
  it("an app-named surface validates and compiles, with no fork", () => {
    expect(validateExperience(exp(), catalog, "voice").ok).toBe(true);
    const r = compile(exp(), { ...opts, surface: "voice" });
    expect(r.ok).toBe(true);
    expect(r.blueprint.layout).toBeDefined();
  });

  it("a surface an entry does not resolve is the ordinary finding, whatever its name", () => {
    const r = validateExperience(exp(), catalog, "native");
    expect(r.findings.map((f) => f.code)).toContain("unresolvable-on-surface");
  });

  it("names the two surfaces with a first-party renderer, and not chat", () => {
    expect([...WELL_KNOWN_SURFACES]).toEqual(["web", "terminal"]);
  });
});

describe("open kind-contract vocabulary", () => {
  const contracts = catalog.valueContracts;

  it("a host kind's value is checked against the host's contract", () => {
    expect(checkKindValue("SpokenGauge", { level: 3 }, contracts)).toEqual({ ok: true });
    const bad = checkKindValue("SpokenGauge", { level: "high" }, contracts);
    expect(!bad.ok && bad.finding.code).toBe("value-contract");
    expect(!bad.ok && bad.finding.message).toContain('kind "SpokenGauge"');
    expect(!bad.ok && bad.finding.message).toContain("level");
  });

  it("the zod-free browser check agrees with the zod-backed one on a host kind", () => {
    for (const v of [{ level: 3 }, { level: "x" }, 7, null]) {
      expect(checkBrowser("SpokenGauge", v, contracts)).toEqual(
        checkKindValue("SpokenGauge", v, contracts)
      );
    }
  });

  it("not hydrated yet (undefined) passes, as for a framework kind", () => {
    expect(checkKindValue("SpokenGauge", undefined, contracts)).toEqual({ ok: true });
  });

  it("without the registry a host kind is uncontracted: it passes the value check, and says so", () => {
    expect(checkKindValue("SpokenGauge", "anything")).toEqual({ ok: true });
    expect(hasKindContract("SpokenGauge")).toBe(false);
    expect(hasBrowser("SpokenGauge")).toBe(false);
    expect(hasKindContract("SpokenGauge", contracts)).toBe(true);
    expect(hasBrowser("SpokenGauge", contracts)).toBe(true);
    expect(hasKindContract("MetricCard")).toBe(true);
  });

  it("a registry never reaches through the prototype", () => {
    expect(hasKindContract("toString", contracts)).toBe(false);
    expect(hasKindContract("__proto__", contracts)).toBe(false);
    expect(checkKindValue("constructor", 1, contracts)).toEqual({ ok: true });
  });

  it("the framework's contract wins for a framework kind: a host cannot loosen it", () => {
    const loosening = { MetricCard: z.unknown(), Note: z.string() };
    expect(checkKindValue("MetricCard", "not a number", loosening).ok).toBe(false);
    expect(checkBrowser("MetricCard", "not a number", loosening).ok).toBe(false);
    expect(checkKindValue("Note", "text", loosening).ok).toBe(false); // Note takes no value at all
    expect(checkKindValue("MetricCard", 5, { MetricCard: z.string() }).ok).toBe(true);
  });

  it("a catalogue that declares a framework kind's contract is an error finding, not a throw", () => {
    const bad = defineSemanticCatalog({ ...catalog, valueContracts: { MetricCard: z.unknown() } });
    const r = validateExperience(exp(), bad, "web");
    const f = r.findings.find((x) => x.code === "contract-overrides-framework");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("MetricCard");
    expect(r.ok).toBe(false);
  });
});

describe("a contract-checked provider never feeds an uncontracted kind", () => {
  it("is a finding at validation, naming the node and the kind", () => {
    const noContracts = defineSemanticCatalog({ id: catalog.id, entries: catalog.entries });
    const r = validateExperience(exp("contract"), noContracts, "voice");
    const f = r.findings.find((x) => x.code === "output-contract-uncontracted");
    expect(f?.severity).toBe("error");
    expect(f?.nodeId).toBe("g");
    expect(f?.message).toContain("SpokenGauge");
  });

  it("passes once the catalogue declares the contract, and for a framework kind", () => {
    expect(validateExperience(exp("contract"), catalog, "voice").findings).toEqual([]);
    expect(validateExperience(exp("contract"), catalog, "web").findings).toEqual([]);
  });

  it("a shape-checked provider is not affected", () => {
    const noContracts = defineSemanticCatalog({ id: catalog.id, entries: catalog.entries });
    expect(validateExperience(exp(), noContracts, "voice").findings).toEqual([]);
  });
});
