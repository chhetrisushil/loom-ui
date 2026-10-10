import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createLitRegistry, litRegistry } from "../dom/litRegistry";
import "../register";

// G13: a host that draws its own chrome (title bar, frame) must be able to get a widget BODY
// without a second title. `chrome="host"` removes every VISIBLE title; the accessible name keeps it.

const b = { projectionId: "hydration", path: "values.h" };
const TITLE = "ZZ-Host-Title";
type Mounted = HTMLElement & { updateComplete: Promise<unknown> };

const pts = [
  { timestamp: "2024-01-01T00:00:00Z", value: 1 },
  { timestamp: "2024-01-02T00:00:00Z", value: 2 },
];

// [tag, kind, a valid value]. Every kind the lit renderer registers.
const KINDS: ReadonlyArray<readonly [string, string, unknown]> = [
  ["lu-metric-card", "MetricCard", 412],
  ["lu-status-badge", "StatusBadge", "ok"],
  ["lu-data-table", "DataTable", [{ db: "orders" }]],
  ["lu-timeseries", "TimeSeries", { series: [{ label: "rps", points: pts }] }],
  ["lu-bar-chart", "BarChart", { bars: [{ label: "a", value: 1 }] }],
  ["lu-kpi", "Kpi", { value: 7, label: "vs last week" }],
  ["lu-table", "Table", { columns: ["db"], rows: [["orders"]] }],
  ["lu-status-card", "StatusCard", { level: "ok", headline: "Fine" }],
  ["lu-note", "Note", undefined],
  ["lu-progress", "ProgressBar", 5],
  ["lu-alert", "AlertCard", "careful"],
  ["lu-text", "StreamingText", "hello"],
  ["lu-list", "Timeline", [{ message: "m" }]],
  ["lu-approval", "ApprovalCard", true],
];

const widgetFor = (kind: string, title: string | undefined) =>
  customWidget$({
    kind,
    id: `w-${kind}`,
    ...(title === undefined ? {} : { title }),
    ...(kind === "Note" ? {} : { binding: b }),
    ...(kind === "Note" ? { props: { text: "body text" } } : {}),
  });

async function mount(
  tag: string,
  props: Record<string, unknown>,
  chrome?: "host" | "widget"
): Promise<Mounted> {
  const el = document.createElement(tag) as Mounted;
  Object.assign(el, props);
  if (chrome !== undefined) (el as unknown as { chrome: string }).chrome = chrome;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** What a sighted reader sees: the shadow text minus screen-reader-only nodes. */
function visible(el: HTMLElement): string {
  const clone = el.shadowRoot?.cloneNode(true) as DocumentFragment;
  for (const n of clone.querySelectorAll(".sr-only")) n.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}
const names = (el: HTMLElement): string =>
  [...(el.shadowRoot?.querySelectorAll("[aria-label]") ?? [])]
    .map((n) => n.getAttribute("aria-label"))
    .join("|");

describe("chrome: host — every kind, ready", () => {
  for (const [tag, kind, value] of KINDS) {
    it(`${tag}: the default shows the title or none; chrome="host" never shows it; the name keeps it`, async () => {
      const dflt = await mount(tag, { widget: widgetFor(kind, TITLE), value });
      const host = await mount(tag, { widget: widgetFor(kind, TITLE), value }, "host");
      expect(host.getAttribute("chrome")).toBe("host");
      expect(dflt.getAttribute("chrome")).toBe("widget");
      expect(visible(host)).not.toContain(TITLE);
      // The accessible name is a title's other job: chrome is visual, so the name stays.
      expect(names(host)).toContain(TITLE);
      expect(names(dflt)).toBe(names(host));
      // The body itself is unchanged apart from the title.
      expect(visible(host).length).toBeGreaterThan(0);
    });
  }
  it("the widgets that print a title by default still do (default unchanged)", async () => {
    for (const [tag, kind, value] of KINDS) {
      if (!["lu-metric-card", "lu-status-badge", "lu-kpi", "lu-note", "lu-approval"].includes(tag))
        continue;
      const el = await mount(tag, { widget: widgetFor(kind, TITLE), value });
      expect(visible(el), tag).toContain(TITLE);
    }
  });
  it("the Kpi caption survives the host title", async () => {
    const el = await mount(
      "lu-kpi",
      { widget: widgetFor("Kpi", TITLE), value: { value: 7, label: "vs last week" } },
      "host"
    );
    expect(visible(el)).toContain("vs last week");
  });
});

describe("chrome: host — error, empty, stale and loading bodies", () => {
  const states: ReadonlyArray<readonly [string, unknown, unknown, string]> = [
    ["error (status)", 5, { state: "error", finding: { code: "X", message: "boom" } }, "boom"],
    ["empty", undefined, { state: "empty" }, "No data"],
    [
      "stale, no value",
      undefined,
      { state: "stale", finding: { code: "S", message: "old" } },
      "old",
    ],
  ];
  for (const [name, value, status, expected] of states) {
    it(`${name}: the default prefixes the title, chrome="host" is the message alone`, async () => {
      const w = widgetFor("MetricCard", TITLE);
      const dflt = await mount("lu-metric-card", { widget: w, value, status });
      const host = await mount("lu-metric-card", { widget: w, value, status }, "host");
      expect(visible(dflt)).toContain(`${TITLE}: `);
      expect(visible(host)).toContain(expected);
      expect(visible(host)).not.toContain(TITLE);
    });
  }
  it("a contract violation renders the finding without the title under chrome=host", async () => {
    const w = widgetFor("Kpi", TITLE);
    const dflt = await mount("lu-kpi", { widget: w, value: 7 });
    const host = await mount("lu-kpi", { widget: w, value: 7 }, "host");
    expect(visible(dflt)).toContain(`${TITLE}: `);
    expect(visible(host)).not.toContain(TITLE);
    expect(visible(host).length).toBeGreaterThan(0);
  });
});

describe("non-string titles are no title on EVERY kind (default chrome)", () => {
  for (const title of ["", 0, 5, null, true] as unknown[]) {
    for (const [tag, kind, value] of KINDS) {
      it(`${tag} with title ${JSON.stringify(title)} renders exactly as with no title`, async () => {
        const none = await mount(tag, { widget: widgetFor(kind, undefined), value });
        const w = { ...widgetFor(kind, undefined), title } as never;
        const el = await mount(tag, { widget: w, value });
        // Compared with the title-less widget (a digit title would collide with chart numbers).
        expect(visible(el)).toBe(visible(none));
        expect(names(el)).toBe(names(none));
        expect(el.shadowRoot?.querySelector(".badge-title")).toBeNull();
      });
    }
  }
});

describe("only a non-empty string is a title (not empty, 0 or 5) — one rule for every widget", () => {
  for (const title of ["", 0 as unknown as string, 5 as unknown as string]) {
    it(`Note with title ${JSON.stringify(title)}: no title element, no empty aria-label`, async () => {
      const el = await mount("lu-note", { widget: widgetFor("Note", title) });
      expect(el.shadowRoot?.querySelector(".title")).toBeNull();
      expect(el.shadowRoot?.querySelector("[role=note]")?.hasAttribute("aria-label")).toBe(false);
    });
    it(`a bound widget with title ${JSON.stringify(title)} falls back to its kind`, async () => {
      const el = await mount("lu-metric-card", {
        widget: widgetFor("MetricCard", title),
        value: 1,
      });
      expect(visible(el)).toContain("MetricCard");
      expect(names(el)).toContain("MetricCard");
    });
  }
});

describe("registry option", () => {
  async function through(reg: ReturnType<typeof createLitRegistry>): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    reg.get("Kpi")?.(host, {
      widget: widgetFor("Kpi", TITLE),
      value: { value: 7 },
      status: undefined,
      onAction: undefined,
    } as never);
    const el = host.firstElementChild as Mounted;
    await el.updateComplete;
    return el;
  }
  it("createLitRegistry({ chrome: 'host' }) mounts every widget in host chrome", async () => {
    const el = await through(createLitRegistry({ chrome: "host" }));
    expect(el.getAttribute("chrome")).toBe("host");
    expect(visible(el)).not.toContain(TITLE);
  });
  it("the default registry (litRegistry) is unchanged", async () => {
    const el = await through(litRegistry);
    expect(el.getAttribute("chrome")).toBe("widget");
    expect(visible(el)).toContain(TITLE);
  });
});
