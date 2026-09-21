import { defineSemanticCatalog } from "./catalog";

/** A small catalogue covering every resolution shape: built-in kind, non-built-in kind with its own contract, degrade chain, degrade cycle. Test-only. */
export const testCatalog = defineSemanticCatalog({
  id: "test.semantic.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
    {
      name: "Status",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "StatusBadge" }, terminal: { kind: "StatusBadge" } },
    },
    {
      name: "Collection",
      version: "1.0.0",
      props: ["columns"],
      binding: "required",
      surfaces: { web: { kind: "DataTable" }, terminal: { kind: "DataTable" } },
    },
    {
      name: "Trend",
      version: "1.0.0",
      props: ["series"],
      binding: "required",
      surfaces: {
        web: { kind: "TimeSeries", props: ["series"], binding: "required" },
        terminal: { degradeTo: { name: "Collection", version: "1.0.0" } },
      },
    },
    {
      name: "Explainer",
      version: "1.0.0",
      props: [],
      binding: "none",
      surfaces: { web: { kind: "Note", props: [], binding: "none" } },
    },
    {
      name: "Loop",
      version: "1.0.0",
      props: [],
      binding: "none",
      surfaces: { web: { degradeTo: { name: "Loop", version: "1.0.0" } } },
    },
  ],
});
