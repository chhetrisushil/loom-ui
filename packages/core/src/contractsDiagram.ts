// The DEFERRED Diagram contract (see kindValues.ts): zod-free, entering a browser bundle only
// through useDiagramContracts(). The same contract as values.ts's zod schema — kindValues.test.ts's
// differential corpus pins the two equal.
import { DIAGRAM_LAYOUTS, diagramProblems } from "./diagramStructure";
import {
  type Out,
  type Path,
  type Status,
  array,
  enumOf,
  fail,
  installDeferredContracts,
  object,
  opt,
  optionalRefs,
  optionalString,
  string,
  timeFormat,
} from "./kindValues";

const diagram = (v: unknown, p: Path, out: Out): Status => {
  const status = object(v, p, out, [
    ["layout", enumOf(DIAGRAM_LAYOUTS)],
    ["title", optionalString],
    ["timeFormat", (x, xp, xo) => opt(x, xp, xo, { optional: true }, timeFormat)],
    [
      "nodes",
      (x, xp, xo) =>
        array(x, xp, xo, (n, np, no) =>
          object(n, np, no, [
            ["id", string],
            ["label", string],
            ["kind", optionalString],
            ["group", optionalString],
            ["at", optionalString],
          ])
        ),
    ],
    [
      "edges",
      (x, xp, xo) =>
        array(x, xp, xo, (e, ep, eo) =>
          object(e, ep, eo, [
            ["from", string],
            ["to", string],
            ["label", optionalString],
            ["kind", optionalString],
          ])
        ),
    ],
    ["refs", optionalRefs],
  ]);
  // Like zod's `superRefine`: the structural rules run unless a type error aborted the parse.
  if (status === "aborted") return status;
  let worst: Status = status;
  for (const problem of diagramProblems(v as Record<string, unknown>)) {
    for (const seg of problem.path) p.push(seg);
    fail(out, p, problem.message);
    p.length -= problem.path.length;
    worst = "dirty";
  }
  return worst;
};
/** Load the Diagram contract into `checkKindValue`. Idempotent; renderer-lit's `defineDiagram()` calls it. */
export function useDiagramContracts(): void {
  installDeferredContracts({ Diagram: diagram });
}
