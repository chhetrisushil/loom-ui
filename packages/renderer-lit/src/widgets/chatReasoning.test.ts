import { ChatFeed, type ChatValue } from "@loom-ui/core/chat";
import { LOAD_REASONING_ACTION } from "@loom-ui/core/chat";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-chat";

// Reasoning in the transcript (loom ADR 0133 D6): a collapsed-by-default, labelled disclosure per reply.
// Model output derived from untrusted input, so TEXT only. A reply without reasoning draws exactly as before.

const b = { projectionId: "hydration", path: "values.h" };
type Mounted = HTMLElement & {
  updateComplete: Promise<unknown>;
  value: unknown;
  onAction?: unknown;
};
const settle = async (el: Mounted) => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
};
const mount = async (value: unknown, extra: Record<string, unknown> = {}) => {
  const el = document.createElement("lu-chat") as Mounted;
  Object.assign(el, {
    widget: customWidget$({
      kind: "Chat",
      id: "chat",
      title: "Support chat",
      binding: b,
      props: {},
    }),
    value,
    ...extra,
  });
  document.body.appendChild(el);
  await settle(el);
  return el;
};
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;
const q = <T extends Element>(el: HTMLElement, sel: string) =>
  root(el).querySelector(sel) as T | null;
const qa = (el: HTMLElement, sel: string) => [...root(el).querySelectorAll(sel)];

const reply = (over: Record<string, unknown> = {}) => ({
  id: "t1.assistant",
  turn: 1,
  role: "assistant",
  status: "complete",
  cursor: "0.3",
  parts: [{ type: "text", text: "The answer" }],
  ...over,
});
const value = (entries: unknown[]) => ({ entries, mode: "owner" }) as ChatValue;
const reasoning = (over: Record<string, unknown> = {}) => ({
  text: "step one, step two",
  kind: "text",
  streaming: false,
  ...over,
});
const toggle = (el: HTMLElement) => q<HTMLButtonElement>(el, "[data-reasoning-toggle]");
const region = (el: HTMLElement) => q<HTMLElement>(el, "[data-reasoning] [role=region]");

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lu-chat reasoning: a reply without it is unchanged", () => {
  it("draws no disclosure and the very same DOM as a value that never heard of reasoning", async () => {
    const plain = await mount(value([reply()]));
    const withKey = await mount(value([reply({ reasoning: undefined })]));
    expect(q(plain, "[data-reasoning]")).toBeNull();
    expect(root(withKey).innerHTML).toBe(root(plain).innerHTML);
    expect(root(plain).innerHTML).not.toContain("easoning");
  });

  it("a feed with reasoning off, fed reasoning events, renders as one that never saw them", async () => {
    const run = (opts: ConstructorParameters<typeof ChatFeed>[0]) => {
      const f = new ChatFeed(opts);
      f.applyEvent("message", {
        turn: 1,
        role: "user",
        text: "q",
        status: "complete",
        cursor: "0.2",
      });
      f.applyEvent("reasoning", { turn: 1, text: "hidden thought" });
      f.applyEvent("delta", { turn: 1, text: "Hi" });
      f.applyEvent("message", {
        turn: 1,
        role: "assistant",
        text: "Hi",
        status: "complete",
        cursor: "0.3",
      });
      return f.value();
    };
    const off = await mount(run({ mode: "owner" }));
    expect(q(off, "[data-reasoning]")).toBeNull();
    expect(root(off).textContent).not.toContain("hidden thought");
  });
});

describe("lu-chat reasoning: the disclosure", () => {
  it("is collapsed by default: a button (aria-expanded=false) controlling a hidden, labelled region with no text drawn", async () => {
    const el = await mount(value([reply({ reasoning: reasoning() })]));
    const btn = toggle(el);
    const reg = region(el);
    expect(btn?.tagName).toBe("BUTTON");
    expect(btn?.getAttribute("type")).toBe("button");
    expect(btn?.textContent?.trim()).toBe("Reasoning");
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
    expect(reg?.hasAttribute("hidden")).toBe(true);
    expect(root(el).textContent).not.toContain("step one");
    // the button controls the region and the region is named by the button
    expect(btn?.getAttribute("aria-controls")).toBe(reg?.id);
    expect(reg?.getAttribute("aria-labelledby")).toBe(btn?.id);
    expect(root(el).getElementById(reg?.id as string)).toBe(reg);
    expect(root(el).getElementById(btn?.id as string)).toBe(btn);
  });

  it("opens and closes with the button, and the text is drawn only while open", async () => {
    const el = await mount(value([reply({ reasoning: reasoning() })]));
    toggle(el)?.click();
    await settle(el);
    expect(toggle(el)?.getAttribute("aria-expanded")).toBe("true");
    expect(region(el)?.hasAttribute("hidden")).toBe(false);
    expect(q(el, "[data-reasoning-text]")?.textContent).toBe("step one, step two");
    toggle(el)?.click();
    await settle(el);
    expect(toggle(el)?.getAttribute("aria-expanded")).toBe("false");
    expect(region(el)?.hasAttribute("hidden")).toBe(true);
    expect(root(el).textContent).not.toContain("step one");
  });

  it("the toggle is keyboard-operable (a native button) and the region is not a live announcement", async () => {
    const el = await mount(value([reply({ reasoning: reasoning() })]));
    expect(toggle(el)?.hasAttribute("disabled")).toBe(false);
    expect(toggle(el)?.getAttribute("tabindex")).toBeNull(); // in the tab order by default
    expect(region(el)?.getAttribute("aria-live")).toBe("off");
  });

  it("each reply has its own disclosure and its own ids; opening one leaves the other closed", async () => {
    const el = await mount(
      value([
        reply({ reasoning: reasoning({ text: "first" }) }),
        reply({
          id: "t2.assistant",
          turn: 2,
          cursor: "0.5",
          reasoning: reasoning({ text: "second" }),
        }),
      ])
    );
    const btns = qa(el, "[data-reasoning-toggle]") as HTMLButtonElement[];
    expect(btns).toHaveLength(2);
    expect(new Set(btns.map((x) => x.id)).size).toBe(2);
    btns[1]?.click();
    await settle(el);
    expect(btns.map((x) => x.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(root(el).textContent).toContain("second");
    expect(root(el).textContent).not.toContain("first");
  });

  it("stays open while the reasoning streams and updates live; the reply keeps its slot", async () => {
    const f = new ChatFeed({ reasoning: true, mode: "owner" });
    f.applyEvent("message", {
      turn: 1,
      role: "user",
      text: "q",
      status: "complete",
      cursor: "0.2",
    });
    f.applyEvent("reasoning", { turn: 1, text: "Thin" });
    const el = await mount(f.value());
    expect(toggle(el)?.textContent).toContain("in progress");
    toggle(el)?.click();
    await settle(el);
    expect(q(el, "[data-reasoning-text]")?.textContent).toBe("Thin");
    f.applyEvent("reasoning", { turn: 1, text: "king" });
    el.value = f.value();
    await settle(el);
    expect(q(el, "[data-reasoning-text]")?.textContent).toBe("Thinking");
    expect(toggle(el)?.getAttribute("aria-expanded")).toBe("true");
    expect(q(el, ".log")?.getAttribute("aria-busy")).toBe("true");
    // the durable reply lands: same article, same open state, no longer in progress
    f.applyEvent("message", {
      turn: 1,
      role: "assistant",
      text: "Done",
      status: "complete",
      cursor: "0.3",
    });
    el.value = f.value();
    await settle(el);
    expect(toggle(el)?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle(el)?.textContent).not.toContain("in progress");
    expect(q(el, "[data-reasoning-text]")?.textContent).toBe("Thinking");
    expect(qa(el, "article")).toHaveLength(2);
  });
});

describe("lu-chat reasoning: kinds and states", () => {
  const open = async (r: Record<string, unknown>) => {
    const el = await mount(value([reply({ reasoning: r })]));
    toggle(el)?.click();
    await settle(el);
    return el;
  };

  it("a summary is labelled a summary, on the button and in the body", async () => {
    const el = await open(reasoning({ kind: "summary", text: "short version" }));
    expect(toggle(el)?.textContent?.trim()).toBe("Reasoning summary");
    expect(q(el, "[data-reasoning]")?.getAttribute("data-kind")).toBe("summary");
    expect(region(el)?.textContent).toContain("not the full reasoning");
    expect(region(el)?.textContent).toContain("short version");
  });

  it("redacted shows a marker and never any text", async () => {
    const el = await open(reasoning({ kind: "redacted", text: "" }));
    expect(region(el)?.textContent).toContain("redacted");
    expect(q(el, "[data-reasoning-text]")).toBeNull();
  });

  it("erased shows 'Reasoning removed.'", async () => {
    const el = await open(reasoning({ text: "", status: "erased" }));
    expect(region(el)?.textContent?.trim()).toBe("Reasoning removed.");
    expect(q(el, "[data-reasoning-text]")).toBeNull();
  });

  it("a stored text that fails its digest is not shown and says so", async () => {
    const el = await open(reasoning({ text: "", status: "digest-mismatch" }));
    expect(region(el)?.textContent).toContain("could not be verified");
  });

  it("truncated is flagged", async () => {
    const el = await open(reasoning({ truncated: true }));
    expect(region(el)?.textContent).toContain("Shortened");
    expect(region(el)?.textContent).toContain("step one");
  });

  it("unavailable and loading have their own fixed words", async () => {
    expect(
      region(await open(reasoning({ text: "", status: "unavailable" })))?.textContent
    ).toContain("No reasoning is available");
    document.body.innerHTML = "";
    expect(region(await open(reasoning({ text: "", status: "loading" })))?.textContent).toContain(
      "Loading reasoning"
    );
  });

  it("reasoning on a restricted entry is never drawn (a bare placeholder)", async () => {
    const el = await mount(
      value([
        {
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "restricted",
          reasoning: reasoning({ text: "LEAK" }),
        },
      ])
    );
    expect(q(el, "[data-reasoning]")).toBeNull();
    expect(root(el).textContent).not.toContain("LEAK");
  });
});

describe("lu-chat reasoning: untrusted text", () => {
  const attacks = [
    '<img src=x onerror="window.__pwned=1">',
    "<script>window.__pwned=1</script>",
    '<a href="javascript:alert(1)">click</a>',
    "</p><p onclick=alert(1)>x",
    '"><svg onload=alert(1)>',
    "<style>*{display:none}</style>",
  ];

  it("is drawn as literal text, never interpreted as HTML, and never becomes an element", async () => {
    const el = await mount(value([reply({ reasoning: reasoning({ text: attacks.join("\n") }) })]));
    toggle(el)?.click();
    await settle(el);
    for (const tag of ["img", "script", "a", "iframe", "svg", "style", "form", "input"])
      expect(qa(el, `.log ${tag}`), tag).toHaveLength(0);
    const shown = q(el, "[data-reasoning-text]");
    expect(shown?.textContent).toBe(attacks.join("\n"));
    expect(shown?.children).toHaveLength(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("is cleaned again here (terminal escapes, bidi overrides) even if the source did not", async () => {
    const el = await mount(value([reply({ reasoning: reasoning({ text: "a\u001b[31mb‮c" }) })]));
    toggle(el)?.click();
    await settle(el);
    expect(q(el, "[data-reasoning-text]")?.textContent).toBe("a[31mbc");
  });

  it("an unknown kind or status from a careless source draws no text as markup either", async () => {
    const el = await mount(
      value([reply({ reasoning: reasoning({ kind: '"><b>x</b>', text: "t" }) })])
    );
    expect(q(el, "[data-reasoning] b")).toBeNull();
  });

  it("the whole pipeline (feed -> widget) keeps an <img onerror> payload literal", async () => {
    const f = new ChatFeed({ reasoning: true, mode: "owner" });
    f.applyEvent("message", {
      turn: 1,
      role: "user",
      text: "q",
      status: "complete",
      cursor: "0.2",
    });
    f.applyEvent("reasoning", { turn: 1, text: '<img src=x onerror="window.__pwned=1">' });
    f.applyEvent("message", {
      turn: 1,
      role: "assistant",
      text: "ok",
      status: "complete",
      cursor: "0.3",
    });
    const el = await mount(f.value());
    toggle(el)?.click();
    await settle(el);
    expect(qa(el, "img")).toHaveLength(0);
    expect(q(el, "[data-reasoning-text]")?.textContent).toBe(
      '<img src=x onerror="window.__pwned=1">'
    );
  });
});

describe("lu-chat reasoning: the stored reasoning is asked for lazily", () => {
  const unloaded = { text: "", kind: "text", streaming: false, status: "unloaded" };

  it("nothing is requested on render; the first expand emits LOAD_REASONING with that reply's cursor, once", async () => {
    const onAction = vi.fn(async () => ({ ok: true }));
    const el = await mount(value([reply({ reasoning: unloaded })]), { onAction });
    expect(onAction).not.toHaveBeenCalled();
    toggle(el)?.click(); // open
    await settle(el);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({
      type: LOAD_REASONING_ACTION,
      widgetId: "chat",
      payload: { cursor: "0.3" },
    });
    toggle(el)?.click(); // close
    toggle(el)?.click(); // open again
    await settle(el);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("a fixed 'loading' note shows until the host publishes the result", async () => {
    const onAction = vi.fn(async () => ({ ok: true }));
    const el = await mount(value([reply({ reasoning: { ...unloaded, status: "loading" } })]), {
      onAction,
    });
    toggle(el)?.click();
    await settle(el);
    expect(region(el)?.textContent).toContain("Loading reasoning");
    el.value = value([reply({ reasoning: reasoning({ text: "fetched" }) })]);
    await settle(el);
    expect(q(el, "[data-reasoning-text]")?.textContent).toBe("fetched");
  });

  it("a reply whose reasoning is already here never asks", async () => {
    const onAction = vi.fn(async () => ({ ok: true }));
    const el = await mount(value([reply({ reasoning: reasoning() })]), { onAction });
    toggle(el)?.click();
    await settle(el);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("with no host handler it still opens and may ask again later (nothing is pretended)", async () => {
    const el = await mount(value([reply({ reasoning: unloaded })]));
    toggle(el)?.click();
    await settle(el);
    expect(toggle(el)?.getAttribute("aria-expanded")).toBe("true");
    expect(region(el)?.textContent).toContain("Loading reasoning");
  });
});
