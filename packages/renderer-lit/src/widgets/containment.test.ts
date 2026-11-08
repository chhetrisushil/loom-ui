import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../register";
import "../elements/lu-chat";

// An absolutely positioned descendant (a visually hidden `.sr-only` caption, a hit area, a plot) is
// placed against its nearest POSITIONED ancestor. If nothing inside the widget is positioned, that
// ancestor is in the host page, often the page itself: the element sits at its in-flow offset, a
// host's `overflow: hidden | auto` does not clip it, and it stretches the page's scroll height.
// So every such element must find its containing block at or inside its widget's host.

const b = { projectionId: "hydration", path: "values.v" };
const REFS = [{ id: "s1", label: "Report" }];
const LINK = "See [the docs](https://example.com/d) for more.";

// tag -> [kind, value]: each value draws the widget's absolutely positioned parts (captions,
// sr-only text, source markers, a markdown web link and its "opens in a new tab" note).
const CASES: Readonly<Record<string, [string, unknown]>> = {
  "lu-table": ["Table", { columns: ["a"], rows: [["x"]], refs: REFS }],
  "lu-data-table": ["DataTable", [{ db: "orders" }]],
  "lu-status-card": ["StatusCard", { level: "ok", headline: "All good", refs: REFS }],
  "lu-bar-chart": ["BarChart", { bars: [{ label: "a", value: 3 }], refs: REFS }],
  "lu-timeseries": [
    "TimeSeries",
    {
      series: [{ label: "p", points: [{ timestamp: "2026-01-01T00:00:00Z", value: 1 }] }],
      refs: REFS,
    },
  ],
  "lu-diagram": [
    "Diagram",
    { layout: "network", nodes: [{ id: "a", label: "A" }], edges: [], refs: REFS },
  ],
  "lu-prose": ["Prose", { format: "markdown", text: LINK }],
  "lu-chat": [
    "Chat",
    {
      entries: [
        {
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "complete",
          parts: [{ type: "text", text: LINK, format: "markdown" }],
        },
      ],
    },
  ],
};

type El = HTMLElement & { updateComplete: Promise<unknown> };
async function mount(tag: string): Promise<El> {
  const [kind, value] = CASES[tag] as [string, unknown];
  const el = document.createElement(tag) as El;
  Object.assign(el, {
    widget: customWidget$({ kind, id: "w", title: "Probe", binding: b, props: {} }),
    value,
  });
  document.body.appendChild(el);
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
  return el;
}

// happy-dom reports an unstyled element's position as "", which is CSS's initial value: static
const positioned = (e: Element) => !["", "static"].includes(getComputedStyle(e).position);
/** The parent in the flat tree this test cares about: a shadow root's parent is its host. */
const up = (e: Element): Element | null =>
  e.parentElement ?? ((e.parentNode as ShadowRoot | null)?.host as Element | undefined) ?? null;

/** Every absolutely positioned element in `host`'s shadow tree whose containing block is outside it. */
function escapees(host: Element): string[] {
  const out: string[] = [];
  const walk = (root: ShadowRoot | Element) => {
    for (const e of root.querySelectorAll("*")) {
      if (e.shadowRoot) walk(e.shadowRoot);
      if (getComputedStyle(e).position !== "absolute") continue;
      let a = up(e);
      while (a !== null && a !== host && !positioned(a)) a = up(a);
      if (a === null || (a === host && !positioned(host)))
        out.push(`<${e.localName} class="${e.getAttribute("class") ?? ""}">`);
    }
  };
  walk(host.shadowRoot as ShadowRoot);
  return out;
}

describe("an absolutely positioned part never escapes its widget", () => {
  beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
  afterEach(() => {
    for (const tag of Object.keys(CASES))
      for (const el of document.querySelectorAll(tag)) el.remove();
  });

  for (const tag of Object.keys(CASES)) {
    it(`${tag}: every absolute element has its containing block inside the host`, async () => {
      const el = await mount(tag);
      const abs = [...(el.shadowRoot as ShadowRoot).querySelectorAll("*")].filter(
        (e) => getComputedStyle(e).position === "absolute"
      );
      // the case really draws something absolute: otherwise this check is vacuous
      expect(abs.length, tag).toBeGreaterThan(0);
      expect(escapees(el), tag).toEqual([]);
    });
  }

  it("every widget that draws an absolute rule, its own or a shared one, is covered above", () => {
    const dir = __dirname;
    // shared style exports with an absolute rule: a widget that imports one draws it. (refStyles'
    // plain `refStyles` is not here: its only absolute is a ::after inside a relative button.)
    const SHARED = /\b(markdownStyles|chartHostStyles|refOverlayStyles)\b/;
    const covered = new Set(Object.keys(CASES).map((t) => `${t}.ts`));
    const uncovered = readdirSync(dir)
      .filter((f) => /^lu-.*\.ts$/.test(f) && !/\.test(-support)?\.ts$/.test(f))
      .filter((f) => {
        const text = readFileSync(join(dir, f), "utf8");
        return /position:\s*absolute/.test(text) || SHARED.test(text);
      })
      .filter((f) => !covered.has(f));
    expect(uncovered).toEqual([]);
  });
});
