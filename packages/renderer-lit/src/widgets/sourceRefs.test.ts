import { REF_OPEN_ACTION } from "@loom-ui/core/browser";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeValue } from "../a11y";
import { configureI18n, setLocale } from "../i18n";
import "../register";
import { REF_STRIP_HEIGHT } from "../refStyles";

const b = { projectionId: "hydration", path: "values.h" };
type El = HTMLElement & { updateComplete: Promise<boolean> };
type Action = { type: string; widgetId: string; payload: unknown };

const BASE: Readonly<Record<string, [tag: string, value: Record<string, unknown>]>> = {
  Kpi: ["lu-kpi", { value: 4.5 }],
  BarChart: ["lu-bar-chart", { bars: [{ label: "alpha", value: 3 }] }],
  TimeSeries: [
    "lu-timeseries",
    { series: [{ label: "p99", points: [{ timestamp: "2026-01-01T00:00:00Z", value: 1 }] }] },
  ],
  Table: ["lu-table", { columns: ["a"], rows: [["x"]] }],
  StatusCard: ["lu-status-card", { level: "ok", headline: "All good" }],
  Diagram: ["lu-diagram", { layout: "network", nodes: [{ id: "a", label: "Alpha" }], edges: [] }],
};
const KINDS = Object.keys(BASE);
const REFS = [
  { id: "s1", label: "Quarterly report" },
  { id: "s2.x" },
  { id: "s3", label: "Ledger" },
];

async function mount(kind: string, refs: unknown, onAction?: (a: Action) => unknown): Promise<El> {
  const [tag, value] = BASE[kind] as [string, Record<string, unknown>];
  const el = document.createElement(tag) as El;
  Object.assign(el, {
    widget: customWidget$({ kind, id: "w1", title: "Probe", binding: b, props: {} }),
    value: refs === undefined ? value : { ...value, refs },
    ...(onAction === undefined ? {} : { onAction }),
  });
  document.body.appendChild(el);
  for (let i = 0; i < 3; i++) await el.updateComplete;
  return el;
}
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;
const markers = (el: HTMLElement) => [
  ...root(el).querySelectorAll<HTMLElement>("[data-refs] .lu-ref"),
];
/** Wait for a condition (never a fixed sleep). */
async function until(el: El, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !ok(); i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
  expect(ok()).toBe(true);
}

describe("source markers on a data widget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("IntersectionObserver", undefined);
  });
  afterEach(() => {
    configureI18n(undefined);
    setLocale("en-US");
  });

  // A chart draws out of flow, so the strip sits over the plot's top margin: that margin grows by the strip's height
  // when the value cites, and nothing of the plot (a bar, a gridline, a tick label) is drawn under the markers.
  for (const [kind, plotTop] of [
    // the tallest bar reaches near the top of the plot
    [
      "BarChart",
      async (el: El) =>
        Math.min(
          ...[...root(el).querySelectorAll("rect.bar")].map((r) => Number(r.getAttribute("y")))
        ),
    ],
    // the hover crosshair runs from the plot's top edge
    [
      "TimeSeries",
      async (el: El) => {
        root(el)
          .querySelector("svg")
          ?.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 0 }));
        await el.updateComplete;
        return Number(root(el).querySelector("line[stroke-dasharray]")?.getAttribute("y1"));
      },
    ],
  ] as const) {
    it(`${kind}: the plot starts below the source strip, and only when the value cites`, async () => {
      const cited = await plotTop(await mount(kind, REFS, () => undefined));
      const plain = await plotTop(await mount(kind, undefined));
      // 24 px: the markers' hit area (WCAG 2.2 2.5.8), written out so a smaller reserve fails here
      expect(cited).toBeGreaterThanOrEqual(24);
      expect(plain).toBeLessThan(24); // without refs the plot keeps that space
      expect(REF_STRIP_HEIGHT).toBe(24);
    });
  }

  for (const kind of KINDS) {
    describe(kind, () => {
      it("draws numbered buttons in array order, named 'Source n: label', when a host listens", async () => {
        const el = await mount(kind, REFS, () => undefined);
        const m = markers(el);
        expect(m.map((x) => x.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
        expect(m.map((x) => x.textContent?.trim())).toEqual(["1", "2", "3"]);
        expect(m.map((x) => x.getAttribute("aria-label"))).toEqual([
          "Source 1: Quarterly report",
          "Source 2",
          "Source 3: Ledger",
        ]);
        expect(m.map((x) => x.getAttribute("data-ref"))).toEqual(["s1", "s2.x", "s3"]);
        expect(m.every((x) => x.getAttribute("type") === "button")).toBe(true);
      });

      it("emits REF_OPEN { refId, n } for the widget's id on a press", async () => {
        const seen: Action[] = [];
        const el = await mount(kind, REFS, (a) => {
          seen.push(a);
        });
        markers(el)[1]?.click();
        markers(el)[0]?.click();
        await until(el, () => seen.length === 2);
        expect(seen).toEqual([
          { type: REF_OPEN_ACTION, widgetId: "w1", payload: { refId: "s2.x", n: 2 } },
          { type: REF_OPEN_ACTION, widgetId: "w1", payload: { refId: "s1", n: 1 } },
        ]);
      });

      it("draws inert spans, never buttons, when nobody listens", async () => {
        const el = await mount(kind, REFS);
        const m = markers(el);
        expect(m.map((x) => x.tagName)).toEqual(["SPAN", "SPAN", "SPAN"]);
        expect(root(el).querySelectorAll("[data-refs] button")).toHaveLength(0);
        expect(root(el).querySelector("[data-ref-status]")).toBeNull();
        expect(m[0]?.getAttribute("aria-label")).toBe("Source 1: Quarterly report");
      });

      it("draws nothing extra for a value without refs, and nothing for an empty list", async () => {
        for (const refs of [undefined, []]) {
          const el = await mount(kind, refs, () => undefined);
          expect(root(el).querySelector("[data-refs]")).toBeNull();
          expect(root(el).innerHTML).not.toContain("lu-ref");
          expect(root(el).innerHTML).toBe(
            root(await mount(kind, undefined, () => undefined)).innerHTML
          );
        }
      });

      it("shows a label with markup as the characters, never as markup", async () => {
        const hostile = "<img src=x onerror=alert(1)>";
        const el = await mount(kind, [{ id: "s1", label: hostile }], () => undefined);
        expect(root(el).querySelector("[data-refs] img")).toBeNull();
        expect(markers(el)[0]?.getAttribute("aria-label")).toBe(`Source 1: ${hostile}`);
        expect(markers(el)[0]?.getAttribute("title")).toBe(hostile);
      });

      it("refuses 17 refs: the error state, no markers", async () => {
        const el = await mount(
          kind,
          Array.from({ length: 17 }, (_, i) => ({ id: `r${i}` })),
          () => undefined
        );
        expect(root(el).querySelector("[data-state='error']")).not.toBeNull();
        expect(root(el).querySelector("[data-refs]")).toBeNull();
      });
    });
  }

  it("keeps the marker after the widget's title, and a refused answer shows in a status line", async () => {
    const el = await mount("Kpi", REFS, () => ({ ok: false, reason: "gone" }));
    markers(el)[0]?.click();
    const status = () => root(el).querySelector("[data-ref-status]") as HTMLElement;
    await until(el, () => status().hasAttribute("data-error"));
    expect(status().textContent?.trim()).not.toBe("");
    expect(status().getAttribute("role")).toBe("status");
    // The title (Kpi's caption row) comes first in the widget, the strip after it.
    const label = root(el).querySelector(".label") as Element;
    const strip = root(el).querySelector("[data-refs]") as Element;
    expect(label.textContent).toContain("Probe");
    expect(label.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a rejecting host is a failed answer, and an answer of ok clears it", async () => {
    let fail = true;
    const el = await mount("Table", REFS, () => {
      if (fail) throw new Error("boom");
    });
    const status = () => root(el).querySelector("[data-ref-status]") as HTMLElement;
    markers(el)[0]?.click();
    await until(el, () => status().hasAttribute("data-error"));
    fail = false;
    markers(el)[0]?.click();
    await until(el, () => !status().hasAttribute("data-error"));
    expect(status().textContent?.trim()).toBe("");
  });

  it("ignores a second press while an open is in flight", async () => {
    let release: () => void = () => undefined;
    const seen: Action[] = [];
    const el = await mount("StatusCard", REFS, (a) => {
      seen.push(a);
      return new Promise<void>((r) => {
        release = r;
      });
    });
    markers(el)[0]?.click();
    await until(el, () => markers(el)[0]?.getAttribute("aria-disabled") === "true");
    markers(el)[0]?.click();
    expect(seen).toHaveLength(1);
    release();
    await until(el, () => markers(el)[0]?.getAttribute("aria-disabled") === "false");
  });
});

describe("the spoken summary of a value with sources", () => {
  beforeEach(() => setLocale("en-US"));
  it("appends ', N sources' (singular for one), and is unchanged without refs", () => {
    const [, kpi] = BASE.Kpi as [string, Record<string, unknown>];
    const plain = describeValue("Kpi", kpi, "Rate");
    expect(describeValue("Kpi", { ...kpi, refs: [] }, "Rate")).toBe(plain);
    expect(describeValue("Kpi", { ...kpi, refs: [{ id: "a" }] }, "Rate")).toBe(
      `${plain}, 1 source`
    );
    expect(describeValue("Kpi", { ...kpi, refs: REFS }, "Rate")).toBe(`${plain}, 3 sources`);
    for (const kind of KINDS) {
      const [, v] = BASE[kind] as [string, Record<string, unknown>];
      expect(describeValue(kind, { ...v, refs: REFS }, "T")).toBe(
        `${describeValue(kind, v, "T")}, 3 sources`
      );
    }
  });
  it("speaks an invalid list as the error, not a count", () => {
    const [, kpi] = BASE.Kpi as [string, Record<string, unknown>];
    expect(describeValue("Kpi", { ...kpi, refs: [{ id: "bad id" }] }, "Rate")).toBe("Rate: error");
  });
});
