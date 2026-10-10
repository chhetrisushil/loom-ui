import type { Operation } from "./operations";

/** The op that declares a bare provider (`handle`), so a later `bindProvider` to it is accepted. */
export const declareHandle = (handle: string): Operation => ({
  type: "remapProvider",
  handle,
  spec: {
    handle,
    executionGraph: [],
    reshaping: { engine: "JSONPath", scriptRef: "$" },
    outputShapeHash: "",
    cachePolicy: { ttlSeconds: 60, scope: "global" },
  },
});
