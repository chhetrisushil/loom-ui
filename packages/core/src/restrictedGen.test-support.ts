import { defineSemanticCatalog } from "./catalog";
import { genesis } from "./experience";

// A seeded generator of experiences whose node ids are LEXICAL (readable words, as the reference
// planner mints them) and fixed-width, so no id is a substring of another and "does this id appear
// in the output" is an exact question. Shared by the opaque-placeholder-id property tests.

const WORDS = ["payroll", "salary", "layoffs", "merger", "audit", "bonus", "pipeline", "breach"];
/** The handle a node binds: its own readable name, containing no other id as a substring. */
export const handleOf = (id: string): string => `hnd${id.slice(id.indexOf("_"))}`;

/** `payroll_salary_007_z`: readable, unique per index, never a substring of another id. */
export function lex(prefix: string, n: number): string {
  const a = WORDS[n % WORDS.length];
  const b = WORDS[(n * 3 + 1) % WORDS.length];
  return `${prefix}_${a}_${b}_${String(n).padStart(3, "0")}_z`;
}

export const catalog = defineSemanticCatalog({
  id: "t",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" } },
    },
    {
      name: "Proj",
      version: "1.0.0",
      props: [],
      binding: "optional",
      surfaces: { web: { kind: "MetricCard" } },
    },
    {
      name: "Static",
      version: "1.0.0",
      props: [],
      binding: "none",
      surfaces: { web: { kind: "Note", props: [], binding: "none" } },
    },
  ],
});
export type Cls = "internal" | "sensitive" | "secret" | undefined;
export const CLS: Cls[] = [undefined, "internal", "sensitive", "secret"];
export const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "prompt" };

export function rng(seed: number) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return { next, pick: <T>(a: readonly T[]): T => a[Math.floor(next() * a.length)] as T };
}

// biome-ignore lint/suspicious/noExplicitAny: a generator of deliberately loose nodes
export type Any = any;

export function generate(seed: number) {
  const { next, pick } = rng(seed);
  let n = 0;
  const providers: Record<string, unknown> = {};
  const provider = (h: string, tool?: string) => {
    providers[h] = {
      handle: h,
      executionGraph: tool
        ? [
            {
              stepId: "s",
              toolName: tool,
              toolVersion: "1",
              toolSchemaHash: "x",
              arguments: {},
              dependsOn: [],
              idempotent: true,
            },
          ]
        : [],
      reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
      outputShapeHash: "sha256:o",
      cachePolicy: { ttlSeconds: 60, scope: "global" },
    };
  };
  const leaf = (): Any => {
    const id = lex("leaf", n++);
    const base = { id, order: id, kind: "semantic", typeVersion: "1.0.0", span: 6, props: {} };
    const k = pick([
      "bind",
      "bind",
      "bind",
      "projOk",
      "projUnknown",
      "projStale",
      "unresolvable",
      "refused",
      "tool",
      "static",
    ]);
    const c = pick(CLS);
    if (k === "bind" || k === "tool" || k === "unresolvable") {
      provider(handleOf(id), k === "tool" ? pick(["tA", "tB"]) : undefined);
      return {
        ...base,
        type: k === "unresolvable" ? "Nope" : "Metric",
        binding: { handle: handleOf(id), priority: "P1", ...(c && { sensitivity: c }) },
      };
    }
    if (k === "static") return { ...base, type: "Static" };
    const pid = k === "projOk" ? pick(["pA", "pB"]) : k === "projUnknown" ? "pZ" : "pA";
    const out: Any = {
      ...base,
      type: "Proj",
      projection: {
        id: pid,
        version: k === "projStale" ? "9" : "1",
        path: "x",
        ...(c && { sensitivity: c }),
      },
    };
    if (k === "refused") {
      provider(handleOf(id));
      out.binding = { handle: handleOf(id), priority: "P1" };
      out.type = "Metric";
    }
    return out;
  };
  const tree = (depth: number): Any => {
    const id = lex("box", n++);
    const m = depth >= 4 ? 0 : Math.floor(next() * 4);
    const children: Any[] = [];
    for (let i = 0; i < m; i++) children.push(depth < 3 && next() < 0.4 ? tree(depth + 1) : leaf());
    return {
      id,
      order: id,
      kind: "container",
      direction: pick(["column", "row", "grid"]),
      span: 12,
      title: { key: "t", fallback: `T-${id}` },
      children,
    };
  };
  const root = tree(0);
  root.order = "V";
  const exp = {
    ...genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
    versionHash: "sha256:v",
    root,
    providers,
  } as Any;
  const projections = [
    {
      id: "pA",
      version: "1",
      ...(next() < 0.5 && { sensitivity: pick(["internal", "secret"] as const) }),
    },
    { id: "pB", version: "1" },
  ];
  const tc =
    next() < 0.3
      ? {
          declaredToolClasses: { tA: pick(["internal", "secret"] as const) },
          undeclared: pick(["allow", "deny"] as const),
        }
      : {};
  return { exp, root, projections, tc };
}
