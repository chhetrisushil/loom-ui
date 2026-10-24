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
type Prose = HTMLElement & {
  requestUpdate(): void;
  updateComplete: Promise<boolean>;
  value: unknown;
  status: unknown;
};
const settle = async (el: HTMLElement) => {
  for (let i = 0; i < 3; i++) await (el as Prose).updateComplete;
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

  it("removes control and bidi characters from plain text and the note", async () => {
    const bad = "\u202eev\u001b[31mil\u200b\u2066";
    const el = await mount({ format: "plain", text: `a${bad}b`, note: `n${bad}m` });
    expect(root(el).querySelector("pre.plain")?.textContent).toBe("aev[31milb");
    const all = root(el).textContent ?? "";
    expect(["\u202e", "\u001b", "\u200b", "\u2066"].some((c) => all.includes(c))).toBe(false);
    expect(root(el).querySelector(".note")?.textContent).toBe("nev[31milm");
  });

  it("cuts an over-cap plain text at a line break and says so", async () => {
    const line = "x".repeat(99);
    const text = Array.from({ length: 11_000 }, () => line).join("\n");
    const el = await mount({ format: "plain", text });
    const shown = root(el).querySelector("pre.plain")?.textContent ?? "";
    expect(shown.length).toBeLessThanOrEqual(1_048_576);
    expect(shown.length).toBeLessThan(text.length);
    expect(shown.endsWith(line)).toBe(true);
    expect(root(el).querySelector(".cut")?.textContent).toBe("(document cut short)");
  });

  describe("focus marking and landing", () => {
    const paras = (n: number) => Array.from({ length: n }, (_, i) => `para${i} ${"w".repeat(30)}`);
    it("a chunker-shaped focus marks every overlapped block and scrolls to the first one it starts in", async () => {
      const ps = paras(6);
      const text = ps.join("\n\n");
      const n2 = text.indexOf("para2");
      const from = n2 + 10; // mid-way through paragraph 2
      const to = text.indexOf("para4") + 8; // inside paragraph 4
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      const el = await mount({ format: "markdown", text, focus: { from, to } });
      const marked = [...root(el).querySelectorAll("[data-block].focus")].map((e) =>
        e.getAttribute("data-block")
      );
      expect(marked).toEqual(["2", "3", "4"]);
      expect(root(el).querySelector("[data-landing]")?.getAttribute("data-block")).toBe("3");
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(root(el).querySelector("[data-landing]"));
    });

    it("a focus starting exactly at a block start scrolls to that block", async () => {
      const text = paras(5).join("\n\n");
      const from = text.indexOf("para3");
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      const el = await mount({ format: "markdown", text, focus: { from, to: from + 5 } });
      expect(root(el).querySelector("[data-landing]")?.getAttribute("data-block")).toBe("3");
      expect(scrolled.mock.contexts[0]).toBe(root(el).querySelector("[data-block='3']"));
    });

    it("hostile focus neither throws nor marks anything wrongly", async () => {
      const text = paras(3).join("\n\n");
      Element.prototype.scrollIntoView = vi.fn();
      const beyond = await mount({
        format: "markdown",
        text,
        focus: { from: text.length + 50, to: text.length + 90 },
      });
      expect(root(beyond).querySelectorAll("[data-block].focus")).toHaveLength(0);
      document.body.innerHTML = "";
      const huge = await mount({ format: "markdown", text, focus: { from: 1e15, to: 1e15 + 1 } });
      expect(root(huge).querySelectorAll("[data-block].focus")).toHaveLength(0);
      document.body.innerHTML = "";
      const inverted = await mount({ format: "markdown", text, focus: { from: 5, to: 0 } });
      const marked = [...root(inverted).querySelectorAll("[data-block].focus")];
      expect(marked.map((e) => e.getAttribute("data-block"))).toEqual(["0"]);
    });

    it("plain text renders exactly the focused substring in mark.focus and scrolls once", async () => {
      const text = "line one\nline two\nline three";
      const from = text.indexOf("two");
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      const el = await mount({ format: "plain", text, focus: { from, to: from + 3 } });
      const marks = root(el).querySelectorAll("pre.plain mark.focus");
      expect(marks).toHaveLength(1);
      expect(marks[0]?.textContent).toBe("two");
      expect(root(el).querySelector("pre.plain")?.textContent).toBe(text);
      expect(scrolled).toHaveBeenCalledTimes(1);
    });

    it("plain text keeps raw offsets when unsafe characters precede the focus", async () => {
      const text = "a\u200bb\u202ec target d";
      const from = text.indexOf("target");
      const el = await mount({ format: "plain", text, focus: { from, to: from + 6 } });
      expect(root(el).querySelector("mark.focus")?.textContent).toBe("target");
    });

    it("plain text without a focus has no mark", async () => {
      const el = await mount({ format: "plain", text: "abc" });
      expect(root(el).querySelector("mark")).toBeNull();
    });

    it("does not record the scroll while the block has no boxes, and retries on a later update", async () => {
      const text = paras(3).join("\n\n");
      const from = text.indexOf("para1");
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      const rects = vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([] as never);
      const el = (await mount({
        format: "markdown",
        text,
        focus: { from, to: from + 5 },
      })) as Prose;
      expect(scrolled).not.toHaveBeenCalled();
      rects.mockReturnValue([{}] as never);
      el.requestUpdate();
      await settle(el);
      expect(scrolled).toHaveBeenCalledTimes(1);
      rects.mockRestore();
    });
  });

  describe("lifecycle", () => {
    const doc = (n: number, tag = "p") =>
      Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n\n");
    it("switching documents resets paging", async () => {
      const el = (await mount({ format: "markdown", text: doc(450) })) as Prose;
      (root(el).querySelector("button.more") as HTMLButtonElement).click();
      await settle(el);
      expect(root(el).querySelectorAll("[data-block]")).toHaveLength(450);
      el.value = { format: "markdown", text: doc(450, "q") };
      await settle(el);
      expect(root(el).querySelectorAll("[data-block]")).toHaveLength(300);
    });

    it("a deep focus set before the value is ready still draws its block and scrolls once", async () => {
      const text = doc(400);
      const from = text.indexOf("p350");
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      const el = document.createElement("lu-prose") as Prose;
      Object.assign(el, {
        widget: customWidget$({ kind: "Prose", id: "p", title: "Doc", binding: b }),
        value: { format: "markdown", text, focus: { from, to: from + 4 } },
        status: { state: "pending" },
      });
      document.body.appendChild(el);
      await settle(el);
      el.status = { state: "ready" };
      await settle(el);
      expect(root(el).querySelectorAll("[data-block].focus")).toHaveLength(1);
      expect(scrolled).toHaveBeenCalledTimes(1);
    });

    it("the same focus re-rendered does not scroll twice; a new document with the same length and focus does", async () => {
      const text = doc(400);
      const from = text.indexOf("p350");
      const focus = { from, to: from + 4 };
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      const el = (await mount({ format: "markdown", text, focus })) as Prose;
      el.value = { format: "markdown", text, focus: { ...focus } };
      await settle(el);
      expect(scrolled).toHaveBeenCalledTimes(1);
      const other = text.replace("p350", "z350");
      expect(other.length).toBe(text.length);
      el.value = { format: "markdown", text: other, focus };
      await settle(el);
      expect(scrolled).toHaveBeenCalledTimes(2);
    });
  });
});
