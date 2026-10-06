import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import {
  type Blueprint,
  type DataBinding,
  MetricCard,
  RendererRegistry,
  blueprint$,
  cell,
  flex,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { referenceContainers } from "./containers";
import { type DomWidgetRenderer, renderBlueprintDom } from "./index";

const bind = (handle: string): DataBinding => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
  status: { path: hydrationStatusPath(handle) },
});
const metric = (id: string) => MetricCard({ id, title: id, binding: bind(`h-${id}`), unit: "ms" });

/** A role container over titled panels — the shape a planner's `tabs` / `stepper` compiles to. */
const withRole = (role: string | undefined, panels: Record<string, string[]>): Blueprint =>
  blueprint$({
    id: "e@1",
    title: "Board",
    projections: [HYDRATION_PROJECTION_ID],
    layout: grid({
      columns: 12,
      children: [
        cell(
          12,
          flex({
            id: "set",
            direction: "column",
            ...(role !== undefined && { role }),
            children: Object.entries(panels).map(([title, ids]) =>
              stack({ id: `panel-${title}`, title, children: ids.map(metric) })
            ),
          })
        ),
      ],
    }),
  });

const mount = (bp: Blueprint, containers = referenceContainers()) => {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "e" });
  for (const h of ["a", "b", "c", "d"]) store.setValue(`h-${h}`, `${h}-v`, { state: "ready" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const span: DomWidgetRenderer = (el, props) => {
    const s = document.createElement("span");
    s.textContent = String(props.value);
    el.appendChild(s);
    return {
      update: (v) => {
        s.textContent = String(v);
      },
      dispose: () => s.remove(),
    };
  };
  const handle = renderBlueprintDom(host, bp, {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: new RendererRegistry<DomWidgetRenderer>().register("MetricCard", span),
    containers,
  });
  return { host, handle };
};
const panels = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>("section")].filter(
    (s) => (s.getAttribute("aria-label") ?? "").length > 0
  );
const visible = (host: HTMLElement): string[] =>
  panels(host)
    .filter((p) => !p.hidden)
    .map((p) => p.getAttribute("aria-label") ?? "");

describe("reference containers — tabs", () => {
  const bp = () => withRole("tabs", { One: ["a"], Two: ["b"], Three: ["c"] });

  it("draws a tablist, shows one panel, and labels each panel from its title", () => {
    const { host } = mount(bp());
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["One", "Two", "Three"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(visible(host)).toEqual(["One"]);
    const first = panels(host)[0] as HTMLElement;
    expect(first.getAttribute("role")).toBe("tabpanel");
    expect(first.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    const hidden = panels(host)[1] as HTMLElement;
    expect(hidden.hidden && hidden.hasAttribute("inert")).toBe(true);
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
  });

  it("a click selects; arrow keys wrap and Home/End jump, moving focus", () => {
    const { host } = mount(bp());
    const tab = (i: number) => host.querySelectorAll<HTMLElement>('[role="tab"]')[i] as HTMLElement;
    tab(2).click();
    expect(visible(host)).toEqual(["Three"]);
    tab(2).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(visible(host)).toEqual(["One"]);
    tab(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(visible(host)).toEqual(["Three"]);
    tab(2).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(visible(host)).toEqual(["One"]);
    tab(0).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(visible(host)).toEqual(["Three"]);
  });

  it("keeps the selected tab across a recompose and clamps it when panels go", () => {
    const { host, handle } = mount(bp());
    (host.querySelectorAll('[role="tab"]')[1] as HTMLElement).click();
    handle.update(withRole("tabs", { One: ["a"], Two: ["b"], Three: ["c"], Four: ["d"] }));
    expect(visible(host)).toEqual(["Two"]);
    (host.querySelectorAll('[role="tab"]')[3] as HTMLElement).click();
    handle.update(withRole("tabs", { One: ["a"], Two: ["b"] }));
    expect(visible(host)).toEqual(["Two"]);
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it("Enter/Space on a focused tab keeps focus on it; an update while focused keeps it too", () => {
    const { host, handle } = mount(bp());
    const tab = (i: number) => host.querySelectorAll<HTMLElement>('[role="tab"]')[i] as HTMLElement;
    tab(1).focus();
    expect(document.activeElement).toBe(tab(1));
    // A real browser turns Enter/Space on a button into a click.
    tab(1).click();
    expect(document.activeElement).toBe(tab(1));
    expect(visible(host)).toEqual(["Two"]);
    const before = tab(1);
    handle.update(withRole("tabs", { One: ["a"], Two: ["b"], Three: ["c"], Four: ["d"] }));
    expect(tab(1)).toBe(before);
    expect(document.activeElement).toBe(before);
    tab(1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(tab(2));
  });

  it("wires aria-controls to the panel id, and only the visible panel is tabbable", () => {
    const { host } = mount(bp());
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    panels(host).forEach((p, i) => {
      expect(p.id).not.toBe("");
      expect(tabs[i]?.getAttribute("aria-controls")).toBe(p.id);
    });
    expect(panels(host).map((p) => p.getAttribute("tabindex"))).toEqual(["0", null, null]);
    tabs[2]?.click();
    expect(panels(host).map((p) => p.getAttribute("tabindex"))).toEqual([null, null, "0"]);
  });

  it("a role change or dispose undoes every attribute the chrome set", () => {
    const { host, handle } = mount(bp());
    handle.update(withRole(undefined, { One: ["a"], Two: ["b"], Three: ["c"] }));
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    for (const p of panels(host)) {
      expect(p.hidden).toBe(false);
      expect(p.hasAttribute("inert")).toBe(false);
      expect(p.hasAttribute("aria-hidden")).toBe(false);
      expect(p.getAttribute("role")).toBeNull();
      expect(p.getAttribute("aria-labelledby")).toBeNull();
      expect(p.getAttribute("tabindex")).toBeNull();
    }
  });

  it("with no container registry the same blueprint is a plain titled stack, children intact", () => {
    const { host } = mount(bp(), new RendererRegistry() as never);
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(panels(host)).toHaveLength(3);
    expect(panels(host).every((p) => !p.hidden)).toBe(true);
  });
});

describe("reference containers — stepper", () => {
  const bp = () => withRole("stepper", { Account: ["a"], Payment: ["b"], Pickup: ["c"] });

  it("shows the first step, with position, labels and Back disabled", () => {
    const { host } = mount(bp());
    expect(visible(host)).toEqual(["Account"]);
    const nav = host.querySelector("nav[data-chrome=stepper]") as HTMLElement;
    expect(nav.querySelector("[data-chrome-part=position]")?.textContent).toContain("1 / 3");
    expect([...nav.querySelectorAll("li")].map((l) => l.textContent)).toEqual([
      "Account",
      "Payment",
      "Pickup",
    ]);
    expect((nav.querySelector("[data-chrome-action=back]") as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("Next and Back walk the steps in order and stop at the ends", () => {
    const { host } = mount(bp());
    const next = host.querySelector("[data-chrome-action=next]") as HTMLButtonElement;
    const back = host.querySelector("[data-chrome-action=back]") as HTMLButtonElement;
    next.click();
    next.click();
    expect(visible(host)).toEqual(["Pickup"]);
    expect(next.disabled).toBe(true);
    next.click();
    expect(visible(host)).toEqual(["Pickup"]);
    back.click();
    expect(visible(host)).toEqual(["Payment"]);
  });

  it("dispose shows every step again and removes the chrome", () => {
    const { host, handle } = mount(bp());
    handle.update(withRole(undefined, { Account: ["a"], Payment: ["b"], Pickup: ["c"] }));
    expect(host.querySelector("nav[data-chrome=stepper]")).toBeNull();
    expect(panels(host).every((p) => !p.hidden && !p.hasAttribute("inert"))).toBe(true);
  });
});
