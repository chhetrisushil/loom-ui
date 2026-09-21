import { InMemoryContentStore, encodeValue } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { EXPERIENCE_COMPOSED, getExperience, mintVersionHash, putExperience, seal } from "./log";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });

describe("mintVersionHash / seal", () => {
  it("is a sha256 content address over the artifact, stable across authorship and child order", () => {
    const h = mintVersionHash(g);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(mintVersionHash({ ...g, meta: { ...meta, author: "b" } })).toBe(h);
    expect(mintVersionHash({ ...g, intent: { objective: "y", source: "user" } })).not.toBe(h);
    expect(seal(g).versionHash).toBe(h);
    expect(seal(seal(g)).versionHash).toBe(h);
  });
});

describe("putExperience / getExperience", () => {
  it("round-trips a sealed experience and dedupes identical artifacts", async () => {
    const store = new InMemoryContentStore();
    const a = await putExperience(store, g);
    const b = await putExperience(store, { ...g, meta: { ...meta, author: "b" } });
    expect(a.experience.versionHash).toBe(mintVersionHash(g));
    // Test-adjustment note (pre-declared by the brief): what is STORED includes `meta`, so two
    // authors of the same artifact store different bytes under different refs, even though their
    // artifact identity (versionHash) is the same. The original assertion here compared refs for
    // equality; that contradicts the design, so it is replaced with the pair below.
    expect(a.experience.versionHash).toBe(b.experience.versionHash);
    expect(a.ref.__loomContent).not.toBe(b.ref.__loomContent);
    const back = await getExperience(store, a.ref);
    expect(back.ok && back.experience).toEqual(a.experience);
  });
  it("a missing ref and a tampered blob are findings, not throws", async () => {
    const store = new InMemoryContentStore();
    const missing = await getExperience(store, { __loomContent: `sha256:${"0".repeat(64)}` });
    expect(!missing.ok && missing.finding.code).toBe("artifact-missing");
    const forged = { ...seal(g), versionHash: `sha256:${"f".repeat(64)}` };
    const ref = await store.put(encodeValue(forged));
    const r = await getExperience(store, ref);
    expect(!r.ok && r.finding.code).toBe("artifact-tampered");
    const junk = await store.put(encodeValue({ not: "an experience" }));
    const j = await getExperience(store, junk);
    expect(!j.ok && j.finding.code).toBe("artifact-invalid");
  });
  it("names the userspace event and its payload shape", () => {
    expect(EXPERIENCE_COMPOSED).toBe("EXPERIENCE_COMPOSED");
  });
});
