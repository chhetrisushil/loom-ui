import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { describeChange, inspectExperience } from "./change";
import { compile } from "./compile";
import { genesis } from "./experience";
import { MEDIA_KINDS, mediaCatalogEntries } from "./media";
import { walk } from "./node";
import { emptyLedger, explainNode } from "./provenance";
import { type Any, CLS, lex, meta, rng } from "./restrictedGen.test-support";
import { snapshotSeen } from "./seen";
import { mayView } from "./viewer";

// U9. PROPERTY: a media reference's ADDRESS is a capability, and it travels only as a hydrated
// value. Over seeded random experiences of media nodes x sensitivity classes x viewers, no address
// (nor caption text) of a node the viewer may not see appears in anything the viewer is handed: the
// compiled Blueprint, the fingerprint inputs, a change description, the seen snapshot, `explainNode`.
// The cleared viewer's own address IS present in the snapshot, so the check is not vacuous.

const KEY = "media-leak-test-key-0123456789abcdef";
const catalog = defineSemanticCatalog({ id: "media", entries: mediaCatalogEntries() });
const viewers: Array<Any> = [
  undefined,
  { clearance: "internal" as const },
  { clearance: "sensitive" as const },
  { clearance: "secret" as const },
];
const addressOf = (id: string): string => `sha256:${Buffer.from(id).toString("hex")}`;
const handleOf = (id: string): string => `hnd_${id}`;

function generateMedia(seed: number) {
  const { next, pick } = rng(seed);
  const providers: Record<string, unknown> = {};
  const values = new Map<string, unknown>();
  const leaves: Any[] = [];
  const count = 4 + Math.floor(next() * 8);
  for (let i = 0; i < count; i++) {
    const id = lex("media", i);
    const kind = pick(MEDIA_KINDS);
    const cls = pick(CLS);
    const handle = handleOf(id);
    providers[handle] = {
      handle,
      executionGraph: [],
      reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
      outputShapeHash: "sha256:o",
      cachePolicy: { ttlSeconds: 60, scope: "global" },
    };
    const family = kind === "File" ? "application/pdf" : `${kind.toLowerCase()}/x`;
    values.set(handle, { address: addressOf(id), mediaType: family, name: `NAME-${id}` });
    leaves.push({
      id,
      order: id,
      kind: "semantic",
      type: kind,
      typeVersion: "1.0.0",
      span: 6,
      props: { caption: `CAP-${id}` },
      binding: { handle, priority: "P1", ...(cls && { sensitivity: cls }) },
    });
  }
  const root = {
    id: "root_box",
    order: "V",
    kind: "container",
    direction: "column",
    span: 12,
    title: { key: "t", fallback: "T" },
    children: leaves,
  };
  const exp = {
    ...genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
    versionHash: "sha256:v",
    root,
    providers,
  } as Any;
  return { exp, values };
}

describe("U9: a hidden media node's address and text never reach a viewer (property)", () => {
  it("0 leaks over 300 seeded experiences x 4 viewers, across every viewer-facing reader", () => {
    const leaks: string[] = [];
    let hidden = 0;
    let shown = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { exp, values } = generateMedia(seed);
      const iopts: Any = { projections: [], hydrationProjectionId: "hydration" };
      const ins = inspectExperience(exp, iopts);
      for (const viewer of viewers) {
        const hiddenIds = [...ins.nodes]
          .filter(([, v]) => v.blocked || !mayView(viewer, v.cls))
          .map(([id]) => id);
        const visibleIds: string[] = [];
        walk(exp.root, (n) => {
          if (n.kind === "semantic" && !hiddenIds.includes(n.id)) visibleIds.push(n.id);
        });
        hidden += hiddenIds.length;
        shown += visibleIds.length;
        const needles = hiddenIds.flatMap((id) => [
          id,
          handleOf(id),
          addressOf(id),
          `CAP-${id}`,
          `NAME-${id}`,
        ]);
        const r = compile(exp, {
          surface: "web",
          catalog,
          hydrationProjectionId: "hydration",
          hydrationProjectionVersion: "1",
          projections: [] as never,
          placeholderKey: KEY,
          ...(viewer !== undefined && { viewer }),
        });
        const reads: string[] = [];
        const seen = snapshotSeen(exp, {
          viewer,
          ...iopts,
          read: (s) => {
            const h = s.kind === "handle" ? s.handle : "";
            reads.push(h);
            return { found: true, value: values.get(h), status: "ready" };
          },
        });
        const explained: unknown[] = [];
        walk(exp.root, (n) =>
          explained.push(
            explainNode(exp, n.id, { viewer, ledger: emptyLedger(), ...iopts } as never)
          )
        );
        const outputs: Record<string, unknown> = {
          blueprint: r.blueprint,
          fingerprint: r.fingerprint,
          change: describeChange(null, exp, { viewer, ...iopts }),
          seen,
          explained,
        };
        for (const [name, out] of Object.entries(outputs)) {
          const json = JSON.stringify(out);
          for (const needle of needles)
            if (json.includes(needle))
              leaks.push(`seed ${seed} ${viewer?.clearance ?? "none"} ${name}: ${needle}`);
        }
        // The host's reader is never even asked for a hidden node's source...
        for (const id of hiddenIds) expect(reads).not.toContain(handleOf(id));
        // ...and the cleared viewer's snapshot DOES carry its own addresses (the check is not vacuous).
        for (const id of visibleIds)
          if (!JSON.stringify(seen).includes(addressOf(id)))
            leaks.push(
              `seed ${seed} ${viewer?.clearance ?? "none"}: visible ${id} missing from seen`
            );
      }
    }
    expect(leaks.slice(0, 5)).toEqual([]);
    expect(hidden).toBeGreaterThan(300);
    expect(shown).toBeGreaterThan(300);
  });

  it("a media value carrying bytes is not kept by the seen log: it is `oversize`, with no value", () => {
    const { exp } = generateMedia(3);
    const bytes = "A".repeat(40 * 1024);
    const snap = snapshotSeen(exp, {
      viewer: { clearance: "secret" },
      projections: [],
      hydrationProjectionId: "hydration",
      read: () => ({
        found: true,
        value: { address: "sha256:ab", mediaType: "image/png", data: bytes },
        status: "ready",
      }),
    });
    const entries = snap.entries.filter((e) => e.state === "oversize");
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(snap)).not.toContain(bytes.slice(0, 64));
  });
});
