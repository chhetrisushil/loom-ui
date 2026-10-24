import { customWidget$ } from "@loom/blueprint-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../register";

const b = { projectionId: "hydration", path: "values.p" };
const mount = async (value: unknown) => {
  const el = document.createElement("lu-prose") as HTMLElement & {
    updateComplete: Promise<boolean>;
  };
  Object.assign(el, {
    widget: customWidget$({ kind: "Prose", id: "p", title: "Doc", binding: b }),
    value,
  });
  document.body.appendChild(el);
  for (let i = 0; i < 3; i++) await el.updateComplete;
  return el;
};
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;

describe("lu-prose", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("IntersectionObserver", undefined);
  });

  it("draws markdown blocks, one wrapper per top-level block", async () => {
    const el = await mount({
      format: "markdown",
      text: "# Title\n\nSome **bold**.\n\n| a |\n|---|\n| 1 |",
    });
    expect(root(el).querySelectorAll("[data-block]")).toHaveLength(3);
    expect(root(el).querySelector(".md .h1")?.textContent).toContain("Title");
    expect(root(el).querySelector(".md strong")?.textContent).toBe("bold");
    expect(root(el).querySelector(".md table")).not.toBeNull();
  });

  it("draws org through the same renderer", async () => {
    const el = await mount({ format: "org", text: "* Head\n/it/" });
    expect(root(el).querySelector(".md .h1")?.textContent).toContain("Head");
    expect(root(el).querySelector(".md em")?.textContent).toBe("it");
  });

  it("draws plain text preformatted", async () => {
    const el = await mount({ format: "plain", text: "a\n  b" });
    expect(root(el).querySelector("pre.plain")?.textContent).toBe("a\n  b");
  });

  it("pages long documents with a Show more button", async () => {
    const text = Array.from({ length: 450 }, (_, i) => `p${i}`).join("\n\n");
    const el = await mount({ format: "markdown", text });
    expect(root(el).querySelectorAll("[data-block]")).toHaveLength(300);
    (root(el).querySelector("button.more") as HTMLButtonElement).click();
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
    expect(root(el).querySelectorAll("[data-block]")).toHaveLength(450);
  });

  it("draws up to the focused block, marks it and scrolls to it", async () => {
    const paras = Array.from({ length: 400 }, (_, i) => `p${i}`);
    const text = paras.join("\n\n");
    const from = text.indexOf("p350");
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const el = await mount({ format: "markdown", text, focus: { from, to: from + 4 } });
    const marked = root(el).querySelectorAll("[data-block].focus");
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("p350");
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("shows the note and the cut line", async () => {
    const el = await mount({
      format: "markdown",
      text: "x",
      truncated: true,
      note: "First part only",
    });
    expect(root(el).textContent).toContain("First part only");
    expect(root(el).textContent).toContain("(document cut short)");
  });

  it("renders the contract error state for a bad value", async () => {
    const el = await mount({ format: "html", text: "<b>x</b>" });
    expect(root(el).querySelector("[data-state=error]")).not.toBeNull();
  });
});
