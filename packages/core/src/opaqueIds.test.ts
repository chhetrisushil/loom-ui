import { describe, expect, it, vi } from "vitest";
import { MIN_ALIAS_KEY_BYTES, PlaceholderKeyError, placeholderAlias } from "./alias";
import { describeChange, inspectExperience } from "./change";
import { compile } from "./compile";
import { type Experience, genesis } from "./experience";
import { walk } from "./node";
import { emptyLedger, explainNode } from "./provenance";
import { type Any, catalog, generate, handleOf } from "./restrictedGen.test-support";
import { snapshotSeen } from "./seen";
import { mayView } from "./viewer";

// U10c. A viewer who may not see a node must not learn its ID: ids are lexical (the reference
// planner mints `payroll_salary_by_employee`), so a restricted placeholder carries a keyed ALIAS.
// PROPERTY: over seeded random experiences x sensitivity assignments x viewers, no hidden node's
// real id (nor its handle, which embeds it) appears anywhere in what the viewer is handed:
// the compiled Blueprint, the fingerprint inputs, `describeChange`, `snapshotSeen`, `explainNode`.
// DOCUMENTED SERVER-SIDE (searched for, not excluded blindly — see the last test): `findings`,
// `restrictedProjectionNodes`, `restrictedHandles`.

const KEY = "opaque-id-test-key-0123456789abcdef";
const viewers: Array<Any> = [
  undefined,
  { clearance: "internal" as const },
  { clearance: "sensitive" as const },
  { clearance: "secret" as const },
];

function baseOpts(projections: unknown, tc: object, viewer: unknown) {
  return {
    surface: "web" as const,
    catalog,
    hydrationProjectionId: "hydration",
    hydrationProjectionVersion: "1",
    projections: projections as never,
    placeholderKey: KEY,
    ...tc,
    ...(viewer !== undefined && { viewer: viewer as never }),
  };
}

/** `next`: a different version of `exp`: first leaf dropped, another leaf's props edited. */
function evolve(exp: Experience): Experience {
  const next = structuredClone(exp) as Any;
  next.versionHash = "sha256:w";
  let dropped = false;
  let edited = false;
  const visit = (c: Any): void => {
    c.children = (c.children as Any[]).filter((ch) => {
      if (!dropped && ch.kind === "semantic") {
        dropped = true;
        return false;
      }
      return true;
    });
    for (const ch of c.children) {
      if (ch.kind === "semantic" && !edited) {
        edited = true;
        ch.props = { ...ch.props, tweak: 1 };
      } else if (ch.kind === "container") visit(ch);
    }
  };
  visit(next.root);
  return next;
}

describe("U10c: no hidden node's real id reaches a viewer (property)", () => {
  it("0 leaks over 400 randomised experiences x 4 viewers, across every viewer-facing reader", () => {
    const leaks: string[] = [];
    let hiddenTotal = 0;
    let aliasedTotal = 0;
    let visibleKept = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const { exp, projections, tc } = generate(seed);
      const next = evolve(exp);
      const iopts: Any = { projections, hydrationProjectionId: "hydration", ...tc };
      const insPrev = inspectExperience(exp, iopts);
      const insNext = inspectExperience(next, iopts);
      for (const viewer of viewers) {
        const hide = (ins: typeof insPrev): string[] =>
          [...ins.nodes].filter(([, v]) => v.blocked || !mayView(viewer, v.cls)).map(([id]) => id);
        // What is hidden in THIS version; a description spans both ("restricted in EITHER").
        const handlesOf = (id: string) => [id, handleOf(id)];
        const hidden = hide(insPrev);
        hiddenTotal += hidden.length;
        const needles = hidden.flatMap(handlesOf);
        // A description lists provider handles by the handle's OWN class (not its node's), so a hidden
        // node's handle can be named when the handle itself is unclassified: ids only there.
        const eitherNeedles = [...new Set([...hidden, ...hide(insNext)])];
        const r = compile(exp, baseOpts(projections, tc, viewer));
        const outputs: Record<string, unknown> = {
          blueprint: r.blueprint,
          fingerprint: r.fingerprint,
          change: describeChange(exp, next, { viewer, ...iopts }),
          changeFirst: describeChange(null, exp, { viewer, ...iopts }),
          changeBack: describeChange(next, exp, { viewer, ...iopts }),
          seen: snapshotSeen(exp, {
            viewer,
            read: () => ({ found: true, value: 1, status: "ready" }),
            ...iopts,
          }),
        };
        // explain every node the viewer might ask about (hidden ones are unavailable)
        const explained: unknown[] = [];
        walk(exp.root, (n) => {
          explained.push(
            explainNode(exp, n.id, { viewer, ledger: emptyLedger(), ...iopts } as never)
          );
        });
        outputs.explained = explained;
        for (const [name, out] of Object.entries(outputs)) {
          const json = JSON.stringify(out);
          const against = name.startsWith("change")
            ? name === "changeFirst"
              ? hidden
              : eitherNeedles
            : name === "explained"
              ? hidden
              : needles;
          for (const needle of against)
            if (json.includes(needle))
              leaks.push(`seed ${seed} ${viewer?.clearance ?? "none"} ${name}: ${needle}`);
        }
        const bp = JSON.stringify(r.blueprint);
        aliasedTotal += (bp.match(/"r_[A-Za-z0-9_-]{16}"/g) ?? []).length;
        // visible nodes that compiled keep their own id
        walk(exp.root, (n) => {
          if (n.kind === "semantic" && !needles.includes(n.id) && bp.includes(`"${n.id}"`))
            visibleKept++;
        });
      }
    }
    expect(leaks.slice(0, 5)).toEqual([]);
    expect(hiddenTotal).toBeGreaterThan(1000); // the generator does hide things
    expect(aliasedTotal).toBeGreaterThan(300); // ...and compile does alias them
    expect(visibleKept).toBeGreaterThan(300); // unrestricted nodes keep real ids
  });

  it("the server-side fields DO name real ids (so the test above is not vacuous)", () => {
    const { exp, projections, tc } = generate(7);
    const r = compile(exp, baseOpts(projections, tc, undefined));
    const server = JSON.stringify([r.findings, r.restrictedHandles, r.restrictedProjectionNodes]);
    expect(server).toMatch(/(leaf|box)_[a-z]+_[a-z]+_\d{3}_z/);
  });
});

describe("U10c: the alias", () => {
  const { exp, projections, tc } = generate(11);
  const restrictedOnly = (r: ReturnType<typeof compile>): string[] =>
    JSON.stringify(r.blueprint).match(/"r_[A-Za-z0-9_-]{16}"/g) ?? [];

  it("is stable for the same key and across versions of the same experience", () => {
    const a = compile(exp, baseOpts(projections, tc, undefined));
    const b = compile(evolve(exp), baseOpts(projections, tc, undefined));
    const inA = new Set(restrictedOnly(a));
    expect(inA.size).toBeGreaterThan(0);
    // every alias in v1 whose node survives in v2 is the same alias
    const survivors = [...inA].filter((x) => restrictedOnly(b).includes(x));
    expect(survivors.length).toBeGreaterThan(0);
  });

  it("differs per experience and per key, and is the exported derivation", () => {
    const other = { ...exp, experienceId: "another" } as Experience;
    const a = restrictedOnly(compile(exp, baseOpts(projections, tc, undefined)));
    const b = restrictedOnly(compile(other, baseOpts(projections, tc, undefined)));
    expect(a.length).toBe(b.length);
    expect(a.filter((x) => b.includes(x))).toEqual([]);
    const k2 = restrictedOnly(
      compile(exp, { ...baseOpts(projections, tc, undefined), placeholderKey: "z".repeat(32) })
    );
    expect(a.filter((x) => k2.includes(x))).toEqual([]);
    const id = (exp.root as Any).id as string;
    expect(placeholderAlias(KEY, exp.experienceId, id)).toMatch(/^r_[A-Za-z0-9_-]{16}$/);
    expect(placeholderAlias(KEY, "ab", "c")).not.toBe(placeholderAlias(KEY, "a", "bc"));
  });

  it("cannot be recovered or confirmed without the key: a dictionary of likely ids finds nothing", () => {
    const { exp: e2, projections: p2, tc: t2 } = generate(5);
    const r = compile(e2, baseOpts(p2, t2, undefined));
    const found = new Set(restrictedOnly(r).map((s) => s.slice(1, -1)));
    expect(found.size).toBeGreaterThan(0);
    const guesses: string[] = [];
    walk(e2.root, (n) => guesses.push(n.id)); // the attacker even knows the real ids
    // unkeyed candidates, and the right derivation under the wrong keys
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    for (const g of guesses) {
      for (const h of ["sha256", "sha1", "md5"]) {
        const d = createHash(h).update(g).digest("base64url");
        for (const f of found) expect(d.startsWith(f.slice(2))).toBe(false);
        const d2 = createHash(h).update(`${e2.experienceId}\u0000${g}`).digest("base64url");
        for (const f of found) expect(d2.startsWith(f.slice(2))).toBe(false);
      }
      for (const wrong of ["", "secret", "k".repeat(MIN_ALIAS_KEY_BYTES)])
        if (wrong.length >= MIN_ALIAS_KEY_BYTES)
          expect(found.has(placeholderAlias(wrong, e2.experienceId, g))).toBe(false);
    }
  });

  it("never collides with a real node id: a node named like an alias moves the alias, not the node", () => {
    const { exp: e3, projections: p3, tc: t3 } = generate(5);
    const first = restrictedOnly(compile(e3, baseOpts(p3, t3, undefined)))[0] as string;
    const squat = structuredClone(e3) as Any;
    // rename a visible leaf (or any container child) to the alias the compile would mint
    let renamed = false;
    walk(squat.root, (n: Any) => {
      if (!renamed && n.kind === "semantic" && !n.binding?.sensitivity && !n.projection) {
        n.id = first.slice(1, -1);
        n.order = n.id;
        renamed = true;
      }
    });
    if (!renamed) return;
    const r = compile(squat, baseOpts(p3, t3, undefined));
    const ids: string[] = [];
    const visit = (x: Any): void => {
      if (x.id) ids.push(x.id);
      for (const c of x.children ?? []) visit(c.node ?? c);
      if (x.node) visit(x.node);
    };
    visit(r.blueprint.layout);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("U10c: the key story is fail-closed", () => {
  const { exp, projections, tc } = generate(11);
  const noKey = (extra: object = {}) => {
    const o = baseOpts(projections, tc, undefined) as Any;
    o.placeholderKey = undefined;
    return compile(exp, { ...o, ...extra });
  };
  const aliasesOf = (r: ReturnType<typeof compile>): string[] =>
    JSON.stringify(r.blueprint).match(/"r_[A-Za-z0-9_-]{16}"/g) ?? [];

  it("no key: still opaque (random per-process key), stable within the process, and one warn", () => {
    const a = noKey();
    const b = noKey();
    expect(aliasesOf(a).length).toBeGreaterThan(0);
    expect(aliasesOf(a)).toEqual(aliasesOf(b));
    expect(a.findings.filter((f) => f.code === "placeholder-alias-key-not-supplied")).toHaveLength(
      1
    );
    // not the keyed derivation: the process key is not any key the host could know
    expect(aliasesOf(a)).not.toEqual(aliasesOf(compile(exp, baseOpts(projections, tc, undefined))));
    const hidden = inspectExperience(exp, {
      projections,
      hydrationProjectionId: "hydration",
      ...tc,
    });
    const json = JSON.stringify(a.blueprint);
    for (const [id, v] of hidden.nodes)
      if (v.blocked || !mayView(undefined, v.cls)) expect(json).not.toContain(id);
  });

  it("the fallback key is random per process: a fresh module instance mints different aliases", async () => {
    const first = aliasesOf(noKey());
    vi.resetModules();
    const fresh = await import("./compile");
    const o = baseOpts(projections, tc, undefined) as Any;
    o.placeholderKey = undefined;
    const second = JSON.stringify(fresh.compile(exp, o).blueprint).match(/"r_[A-Za-z0-9_-]{16}"/g);
    expect(second?.length).toBe(first.length);
    expect(second).not.toEqual(first); // an unkeyed or constant-keyed fallback would repeat
  });

  it("the absent-key warn states the consequence", () => {
    const f = noKey().findings.find((x) => x.code === "placeholder-alias-key-not-supplied");
    expect(f?.message).toMatch(/differ across replicas and restarts/);
    expect(f?.message).toMatch(/refused as stale/);
  });

  it("a SUPPLIED key under the minimum (or of a wrong type) throws a typed error, never a random key", () => {
    for (const bad of ["short", "", new Uint8Array(8), 12345 as never, null as never]) {
      let err: unknown;
      try {
        noKey({ placeholderKey: bad });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PlaceholderKeyError);
      expect((err as PlaceholderKeyError).code).toBe("placeholder-key-weak");
    }
    const good = compile(exp, baseOpts(projections, tc, undefined));
    expect(good.findings.map((x) => x.code)).not.toContain("placeholder-alias-key-not-supplied");
  });

  it("requirePlaceholderKey: no key + anything redacted throws; a key, or nothing redacted, does not", () => {
    expect(() => noKey({ requirePlaceholderKey: true })).toThrow(PlaceholderKeyError);
    try {
      noKey({ requirePlaceholderKey: true });
    } catch (e) {
      expect((e as PlaceholderKeyError).code).toBe("placeholder-key-required");
    }
    expect(() =>
      compile(exp, { ...baseOpts(projections, tc, undefined), requirePlaceholderKey: true })
    ).not.toThrow();
    // nothing redacted (an empty experience): no alias is needed, so no key is required
    const empty = genesis({
      experienceId: "empty",
      intent: { objective: "o", source: "user" },
      meta: { author: "a", createdAt: "2026-10-08T00:00:00Z", sourceKind: "prompt" },
    });
    expect(() =>
      compile(empty, {
        ...baseOpts([], {}, undefined),
        placeholderKey: undefined,
        requirePlaceholderKey: true,
      } as never)
    ).not.toThrow();
  });

  it("no warn when nothing is redacted", () => {
    const r = compile(exp, {
      ...baseOpts(projections, tc, { clearance: "secret" }),
      placeholderKey: undefined,
    } as never);
    if (aliasesOf(r).length === 0)
      expect(r.findings.map((x) => x.code)).not.toContain("placeholder-alias-key-not-supplied");
  });

  it("domain separation: a node id and a handle of the same text alias differently", () => {
    expect(placeholderAlias(KEY, "e", "x", "node")).not.toBe(
      placeholderAlias(KEY, "e", "x", "handle")
    );
  });

  it("lone surrogates hash injectively (UTF-16 code units, not UTF-8)", () => {
    expect(placeholderAlias(KEY, "e", "x\uD800")).not.toBe(placeholderAlias(KEY, "e", "x\uFFFD"));
    expect(placeholderAlias(KEY, "e", "x\uD800")).not.toBe(placeholderAlias(KEY, "e", "x\uDFFF"));
    expect(placeholderAlias(KEY, "e\uD800", "x")).not.toBe(placeholderAlias(KEY, "e\uFFFD", "x"));
  });

  it("placeholderAlias refuses a weak key rather than hashing under it", () => {
    expect(() => placeholderAlias("short", "e", "n")).toThrow(RangeError);
  });

  it("fingerprint: carries aliases, not handles; same keyed alias as the placeholder family", () => {
    const r = compile(exp, baseOpts(projections, tc, undefined));
    expect(r.restrictedHandles.length).toBeGreaterThan(0);
    expect(r.fingerprint.restrictedHandles).toHaveLength(r.restrictedHandles.length);
    for (const h of r.restrictedHandles) expect(JSON.stringify(r.fingerprint)).not.toContain(h);
    expect(r.fingerprint.restrictedHandles).toEqual(
      r.restrictedHandles.map((h) => placeholderAlias(KEY, exp.experienceId, h, "handle")).sort()
    );
  });
});

describe("U10c: tied order keys do not leak a comparison bit of a hidden id", () => {
  const mk = (hiddenId: string) => {
    const leaf = (id: string, sens?: "secret") => ({
      id,
      order: "T", // every sibling tied
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 6,
      props: {},
      binding: { handle: `hnd_${id}`, priority: "P1", ...(sens && { sensitivity: sens }) },
    });
    const kids = [leaf("m_visible"), leaf(hiddenId, "secret"), leaf("zz_visible")];
    const g = genesis({
      experienceId: "tie",
      intent: { objective: "o", source: "user" },
      meta: { author: "a", createdAt: "2026-10-08T00:00:00Z", sourceKind: "prompt" },
    });
    const e = {
      ...g,
      versionHash: "sha256:t",
      root: { ...(g.root as Any), children: kids },
      providers: Object.fromEntries(
        kids.map((k) => [
          k.binding.handle,
          {
            handle: k.binding.handle,
            executionGraph: [],
            reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
            outputShapeHash: "sha256:o",
            cachePolicy: { ttlSeconds: 60, scope: "global" },
          },
        ])
      ),
    } as Any;
    const r = compile(e, {
      ...baseOpts([], {}, { clearance: "internal" }),
      projections: [],
    } as never);
    const ids: string[] = [];
    const visit = (x: Any): void => {
      if (x.id) ids.push(x.id);
      for (const c of x.children ?? []) visit(c.node ?? c);
      if (x.node) visit(x.node);
    };
    visit(r.blueprint.layout);
    return ids.filter((i) => i !== (e.root as Any).id);
  };
  it("the hidden node's slot among tied siblings does not depend on its real id", () => {
    const a = mk("aa_hidden"); // sorts BEFORE the visible ones by real id
    const z = mk("zzz_hidden"); // sorts AFTER them
    const slot = (ids: string[]) => ids.findIndex((i) => i.startsWith("r_"));
    expect(slot(a)).toBe(slot(z));
    expect(a.filter((i) => !i.startsWith("r_"))).toEqual(["m_visible", "zz_visible"]);
  });
});
