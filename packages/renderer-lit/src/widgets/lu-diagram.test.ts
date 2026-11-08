import { type DiagramValue, MAX_DIAGRAM_NODES, diagramOutline } from "@loom-ui/core/browser";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureI18n, setLocale } from "../i18n";
import { say } from "../say";
import "../register";

const b = { projectionId: "hydration", path: "values.d" };
type El = HTMLElement & { updateComplete: Promise<boolean>; value: unknown; status: unknown };
const mount = async (value: unknown, props: Record<string, unknown> = {}) => {
  const el = document.createElement("lu-diagram") as El;
  Object.assign(el, {
    widget: customWidget$({ kind: "Diagram", id: "d", title: "Chart", binding: b, props }),
    value,
  });
  document.body.appendChild(el);
  for (let i = 0; i < 3; i++) await el.updateComplete;
  return el;
};
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, ...extra });
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({
  from,
  to,
  ...extra,
});
const tree = {
  layout: "tree",
  title: "Org",
  nodes: [node("ceo"), node("cto"), node("cfo"), node("dev")],
  edges: [edge("ceo", "cto"), edge("ceo", "cfo"), edge("cto", "dev")],
};
const words = (key: string, vars: Readonly<Record<string, string | number>>): string =>
  say(key as never, vars as never);
const outlineOf = (el: HTMLElement) => [...root(el).querySelectorAll("[data-outline] li")];
/** The text a list item owns directly (not its nested list's). */
const own = (li: Element) => [...li.childNodes].find((n) => n.nodeType === 3)?.textContent;

describe("lu-diagram", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("IntersectionObserver", undefined);
  });
  afterEach(() => {
    configureI18n(undefined);
    setLocale("en-US");
  });

  it("draws a tree: a rect and a label per node, an arrow per edge, a title", async () => {
    const el = await mount(tree);
    expect(root(el).querySelectorAll("svg .node rect")).toHaveLength(4);
    expect([...root(el).querySelectorAll("svg .node text")].map((t) => t.textContent)).toEqual([
      "ceo",
      "cto",
      "cfo",
      "dev",
    ]);
    const edges = root(el).querySelectorAll("svg .edge path");
    expect(edges).toHaveLength(3);
    expect(edges[0]?.getAttribute("marker-end")).toBe("url(#lu-diagram-arrow)");
    expect(root(el).querySelector("marker#lu-diagram-arrow")).not.toBeNull();
    expect(root(el).querySelector(".title")?.textContent).toBe("Org");
    expect(root(el).querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("tree");
  });

  it("draws flow (cycles dashed as back-edges), timeline (axis) and network", async () => {
    const flow = await mount({
      layout: "flow",
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b", { label: "go" }), edge("b", "a")],
    });
    expect(root(flow).querySelectorAll(".edge.back")).toHaveLength(1);
    expect(root(flow).querySelector(".edge text")?.textContent).toBe("go");

    const timeline = await mount({
      layout: "timeline",
      timeFormat: { granularity: "month" },
      nodes: [node("a", { at: "2026-01-05" }), node("b", { at: "2026-04-05" })],
      edges: [],
    });
    const ticks = [...root(timeline).querySelectorAll(".axis text")].map((t) => t.textContent);
    expect(ticks[0]).toBe("Jan 2026");
    expect(ticks.at(-1)).toBe("Apr 2026");
    expect(new Set(ticks).size).toBe(ticks.length); // a label repeated by close ticks is drawn once

    const network = await mount({
      layout: "network",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    });
    expect(root(network).querySelectorAll(".node")).toHaveLength(3);
    expect(root(network).querySelectorAll(".edge")).toHaveLength(3);
  });

  it("labels are data: a markup-looking label renders literally, and creates no element", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const el = await mount({
      layout: "network",
      title: "<b>t</b>",
      nodes: [{ id: "a", label: evil }, node("b")],
      edges: [edge("a", "b", { label: "<script>x</script>" })],
    });
    expect(root(el).querySelector("img, script, b")).toBeNull();
    expect(root(el).querySelector(".node title")?.textContent).toBe(evil);
    expect(root(el).querySelector(".edge text")?.textContent).toBe("<script>x</script>");
    expect(root(el).querySelector(".title")?.textContent).toBe("<b>t</b>");
    expect(outlineOf(el)[0]?.textContent).toBe(`${evil} → b (<script>x</script>)`);
  });

  it("a long label is cut in the drawing and whole in the tooltip and the outline", async () => {
    const long = "L".repeat(60);
    const el = await mount({ layout: "network", nodes: [node("a", { label: long })], edges: [] });
    expect(root(el).querySelector(".node text")?.textContent).toBe(`${"L".repeat(27)}…`);
    expect(root(el).querySelector(".node title")?.textContent).toBe(long);
    expect(outlineOf(el)[0]?.textContent).toBe(long);
  });

  it("the hidden outline is the shared outline: nested for a tree, flat otherwise", async () => {
    const el = await mount(tree);
    const list = root(el).querySelector("[data-outline]") as HTMLElement;
    expect(list.getAttribute("aria-label")).toBe("Diagram outline");
    expect(list.querySelectorAll(":scope > li")).toHaveLength(1); // one root
    expect(list.querySelectorAll("ul")).toHaveLength(2); // ceo's children, cto's children
    expect(outlineOf(el).map(own)).toEqual(["ceo", "cto", "dev", "cfo"]);
    const expected = diagramOutline(tree as unknown as DiagramValue, "en-US", words).map(
      (l) => `${l.depth}:${l.text}`
    );
    const got = outlineOf(el).map((li) => {
      let depth = 0;
      for (let p = li.parentElement; p && p !== list; p = p.parentElement)
        if (p.tagName === "UL") depth++;
      return `${depth}:${own(li)}`;
    });
    expect(got).toEqual(expected);

    const flow = await mount({
      layout: "flow",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b")],
    });
    expect(outlineOf(flow).map((l) => l.textContent)).toEqual(["a → b", "c"]);
    expect(root(flow).querySelectorAll("[data-outline] ul")).toHaveLength(0);
  });

  it("a timeline's outline is dated and chronological", async () => {
    const el = await mount({
      layout: "timeline",
      nodes: [node("b", { at: "2026-03-05" }), node("a", { at: "2026-01-02" })],
      edges: [],
    });
    expect(outlineOf(el).map((l) => l.textContent)).toEqual(["Jan 2, 2026 — a", "Mar 5, 2026 — b"]);
  });

  it("a 200-deep tree nests its outline without recursing", async () => {
    const n = MAX_DIAGRAM_NODES;
    const el = await mount({
      layout: "tree",
      nodes: Array.from({ length: n }, (_, i) => node(`n${i}`)),
      edges: Array.from({ length: n - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`)),
    });
    expect(outlineOf(el)).toHaveLength(n);
    expect(root(el).querySelectorAll("[data-outline] ul")).toHaveLength(n - 1);
  });

  it("the accessible name is the short summary; the svg is hidden; the scroll container is focusable", async () => {
    const el = await mount(tree);
    expect(root(el).querySelector("[data-state]")?.getAttribute("aria-label")).toBe(
      "Chart: diagram, tree, 4 nodes"
    );
    const single = await mount({ layout: "network", nodes: [node("a")], edges: [] });
    expect(root(single).querySelector("[data-state]")?.getAttribute("aria-label")).toBe(
      "Chart: diagram, network, 1 node"
    );
    expect(root(el).querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const scroll = root(el).querySelector(".scroll") as HTMLElement;
    expect(scroll.getAttribute("tabindex")).toBe("0");
    expect(scroll.getAttribute("aria-label")).toBe("diagram, tree, 4 nodes");
    const svg = scroll.querySelector("svg") as SVGElement;
    expect(Number(svg.getAttribute("width"))).toBeGreaterThan(0); // natural size, no zoom
  });

  it("the fixed words come from the catalogue, the labels never do", async () => {
    configureI18n({
      locale: "de-DE",
      messages: {
        "lu.diagram.summary": "Diagramm, {layout}, {n} {noun}",
        "lu.diagram.layout.tree": "Baum",
        "lu.plural.node.one": "Knoten",
        "lu.plural.node.other": "Knoten",
        "lu.diagram.outline": "Gliederung",
        ceo: "BOSS",
      },
    });
    const el = await mount(tree);
    expect(root(el).querySelector("[data-state]")?.getAttribute("aria-label")).toBe(
      "Chart: Diagramm, Baum, 4 Knoten"
    );
    expect(root(el).querySelector("[data-outline]")?.getAttribute("aria-label")).toBe("Gliederung");
    expect(own(outlineOf(el)[0] as Element)).toBe("ceo");
  });

  it("a value that breaks a rule is the error state, not a diagram", async () => {
    for (const bad of [
      { ...tree, nodes: [node("a"), node("a")], edges: [] },
      { ...tree, edges: [edge("ceo", "ghost")] },
      { layout: "tree", nodes: [node("a"), node("b")], edges: [] },
      { layout: "timeline", nodes: [node("a")], edges: [] },
      {
        layout: "network",
        nodes: Array.from({ length: 201 }, (_, i) => node(`n${i}`)),
        edges: [],
      },
    ]) {
      const el = await mount(bad);
      expect(root(el).querySelector("[data-state]")?.getAttribute("data-state")).toBe("error");
      expect(root(el).querySelector("svg")).toBeNull();
      expect(root(el).querySelector("[data-outline]")).toBeNull();
    }
  });

  it("a timeline takes props.timeFormat when the value declares none; a bad prop is ignored", async () => {
    const value = {
      layout: "timeline",
      nodes: [node("a", { at: "2026-01-05" }), node("b", { at: "2026-02-05" })],
      edges: [],
    };
    const el = await mount(value, { timeFormat: { granularity: "month" } });
    expect(outlineOf(el)[0]?.textContent).toBe("Jan 2026 — a");
    const bad = await mount(value, { timeFormat: { granularity: "fortnight" } });
    expect(outlineOf(bad)[0]?.textContent).toBe("Jan 5, 2026 — a");
  });

  it("groups colour nodes deterministically by first appearance, and kind is a data attribute", async () => {
    const el = await mount({
      layout: "network",
      nodes: [
        node("a", { group: "g1", kind: "svc" }),
        node("b", { group: "g2" }),
        node("c", { group: "g1" }),
      ],
      edges: [],
    });
    const rects = [...root(el).querySelectorAll(".node rect")] as SVGElement[];
    expect(rects[0]?.style.stroke).toBeTruthy();
    expect(rects[0]?.style.stroke).toBe(rects[2]?.style.stroke);
    expect(rects[0]?.style.stroke).not.toBe(rects[1]?.style.stroke);
    expect(root(el).querySelector(".node")?.getAttribute("data-kind")).toBe("svc");
  });

  it("redraws when the value changes", async () => {
    const el = await mount(tree);
    el.value = { layout: "network", nodes: [node("z")], edges: [] };
    for (let i = 0; i < 3; i++) await el.updateComplete;
    expect(root(el).querySelectorAll(".node")).toHaveLength(1);
    expect(root(el).querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("network");
  });
});
