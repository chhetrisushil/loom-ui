import { type Experience, genesis } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { describeExperience } from "./prompt";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
} from "./testing.test-support";

describe("describeExperience names the reshaping engine it cannot show as a path", () => {
  it("a Named reshaper is described as Named, never as QuickJS", () => {
    const g = genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
    const exp: Experience = {
      ...g,
      root: {
        id: "root",
        order: "V",
        kind: "container",
        direction: "grid",
        span: 12,
        children: [
          {
            id: "orders",
            order: "a",
            kind: "semantic",
            type: "Metric",
            typeVersion: "1.0.0",
            span: 4,
            props: {},
            binding: { handle: "h1", priority: "P0" },
          },
        ],
      },
      providers: {
        h1: {
          handle: "h1",
          executionGraph: [
            {
              stepId: "s1",
              toolName: "orders.summary",
              toolVersion: "2.1.0",
              toolSchemaHash: "sha256:x",
              arguments: {},
              dependsOn: [],
              idempotent: true,
            },
          ],
          reshaping: { engine: "Named", scriptRef: "orders-to-count" },
          outputShapeHash: "",
          cachePolicy: { ttlSeconds: 60, scope: "principal" },
        },
      },
    };
    const described = JSON.stringify(describeExperience(exp, capabilitiesFixture, planningCatalog));
    expect(described).toContain('"reshaping":"Named"');
    expect(described).not.toContain("QuickJS");
  });
});
