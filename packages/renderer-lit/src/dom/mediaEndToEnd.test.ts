import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
  mediaCatalogEntries,
} from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaLitRegistry } from "../media";
import { renderBlueprintDom } from "./index";

// U9 end to end on the web surface: compile (viewer-aware) -> hydration store -> DOM. A node the
// viewer may not see is an opaque placeholder; even if its value were sitting in the store, nothing
// ever reads it, so the host's resolver is never asked about it and its address, name and caption
// appear nowhere in the DOM.

const catalog = defineSemanticCatalog({ id: "media.e2e", entries: mediaCatalogEntries() });
const KEY = "renderer-lit-u9-key-0123456789ab";
const PUBLIC = {
  address: "sha256:00000000public01",
  mediaType: "image/png",
  name: "PUBLICNAME.png",
};
const HIDDEN = {
  address: "sha256:00000000hidden02",
  mediaType: "image/png",
  name: "HIDDENNAME.png",
};
const g = genesis({
  experienceId: "u9",
  intent: { objective: "show", source: "user" },
  meta: { author: "t", createdAt: "2026-10-08T00:00:00Z", sourceKind: "prompt" },
});
const img = (
  id: string,
  order: string,
  caption: string,
  sensitivity?: "sensitive"
): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Image",
  typeVersion: "1.0.0",
  span: 6,
  props: { caption },
  binding: { handle: `h_${id}`, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const exp = (children: SemanticNode[]) => ({
  ...g,
  versionHash: "sha256:1",
  root: { ...(g.root as ContainerNode), children },
  providers: Object.fromEntries(
    children.map((c) => [
      c.binding?.handle ?? "",
      {
        handle: c.binding?.handle ?? "",
        executionGraph: [],
        reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
        outputShapeHash: "sha256:o",
        cachePolicy: { ttlSeconds: 60, scope: "global" as const },
      },
    ])
  ),
});

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => vi.unstubAllGlobals());

describe("U9: media through compile, hydration and the DOM", () => {
  it("a restricted media node is an opaque placeholder; its address never reaches the DOM or the resolver", async () => {
    const e = exp([
      img("quarterly_payroll_chart", "A", "HIDDENCAPTION", "sensitive"),
      img("public_chart", "B", "PUBLICCAPTION"),
    ]);
    const r = compile(e, {
      surface: "web",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: "1.0.0",
      viewer: { clearance: "internal" },
      placeholderKey: KEY,
    });
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "u9" });
    // WORST CASE: a host that loaded the restricted value anyway.
    store.setValue("h_quarterly_payroll_chart", HIDDEN, { state: "ready" });
    store.setValue("h_public_chart", PUBLIC, { state: "ready" });
    const asked: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = renderBlueprintDom(host, r.blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: createMediaLitRegistry({
        media: {
          resolver: async (req) => {
            asked.push(req.ref.address);
            return { ok: true, url: "https://cdn.example.com/m/1" };
          },
        },
      }),
    });
    await new Promise((res) => setTimeout(res, 20));
    const shadowHtml = (root: ParentNode): string =>
      [...root.querySelectorAll("*")]
        .map((c) => (c as HTMLElement).shadowRoot?.innerHTML ?? "")
        .join("");
    const all = host.innerHTML + shadowHtml(host);
    expect(asked).toEqual([PUBLIC.address]);
    expect(all).toContain("PUBLICCAPTION");
    for (const secret of [HIDDEN.address, "HIDDENNAME", "HIDDENCAPTION", "payroll"])
      expect(all).not.toContain(secret);
    handle.dispose();
    host.remove();
  });
});
