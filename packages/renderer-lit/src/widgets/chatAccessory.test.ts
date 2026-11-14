import { customWidget$ } from "@loomwork/blueprint-runtime";
import type { ChatValue } from "@loomwork/ui-core/chat";
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-chat";
import type { ChatEntryAccessories, ChatEntryRef } from "./chatAccessory";

// Host content under one transcript entry: drawn inside that entry's article after its body, kept
// (the same node, never remounted) across streaming updates, asked again only when the entry's
// status changes or the host says so, and never drawn for a restricted entry.

type Mounted = HTMLElement & {
  updateComplete: Promise<unknown>;
  value: unknown;
  chatAccessories?: ChatEntryAccessories;
};
const settle = async (el: Mounted) => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
};
const b = { projectionId: "hydration", path: "values.h" };
const widget = () =>
  customWidget$({ kind: "Chat", id: "chat", title: "Chat", binding: b, props: {} });
const mount = async (value: unknown, chatAccessories?: ChatEntryAccessories) => {
  const el = document.createElement("lu-chat") as Mounted;
  Object.assign(el, { widget: widget(), value, ...(chatAccessories && { chatAccessories }) });
  document.body.appendChild(el);
  await settle(el);
  return el;
};
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;
const article = (el: HTMLElement, turn: number, role: string) =>
  root(el).querySelector(`article[data-turn="${turn}"][data-role="${role}"]`) as HTMLElement;
const e = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  id: `t${turn}.${role}`,
  turn,
  role,
  status: "complete",
  parts: [{ type: "text", text: `${role} ${turn}` }],
  ...over,
});
const value = (entries: unknown[]) => ({ entries, mode: "owner" }) as ChatValue;

/** A host that draws one owned node per assistant entry and counts what it was asked. */
function host() {
  const nodes = new Map<string, HTMLElement>();
  const asked: ChatEntryRef[] = [];
  let changed: ((id?: string) => void) | undefined;
  let unsubscribed = 0;
  const acc: ChatEntryAccessories = {
    render(entry) {
      asked.push(entry);
      if (entry.role !== "assistant") return null;
      let n = nodes.get(entry.id);
      if (n === undefined) {
        n = document.createElement("section");
        n.setAttribute("aria-label", `Visuals for ${entry.id}`);
        nodes.set(entry.id, n);
      }
      n.textContent = `acc ${entry.id} ${entry.status}`;
      return n;
    },
    subscribe(c) {
      changed = c;
      return () => {
        unsubscribed++;
      };
    },
  };
  return {
    acc,
    nodes,
    asked,
    changed: (id?: string) => changed?.(id),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lu-chat: entry accessories", () => {
  it("draws the host's content inside the entry's article, after its body", async () => {
    const h = host();
    const el = await mount(value([e(1, "user"), e(1, "assistant")]), h.acc);
    const a = article(el, 1, "assistant");
    const box = a.querySelector("[data-entry-accessory]") as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.firstElementChild).toBe(h.nodes.get("t1.assistant"));
    expect(box.getAttribute("part")).toBe("entry-accessory");
    // after the body, in reading order, and inside the article a screen reader announces
    const body = a.querySelector("p, .text, [data-part]") as Element;
    expect(body.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(a.textContent).toContain("acc t1.assistant complete");
    // the user entry: the host answered null, so no box at all
    expect(article(el, 1, "user").querySelector("[data-entry-accessory]")).toBeNull();
  });

  it("keeps the same node across streaming updates, and asks again only when the status changes", async () => {
    const h = host();
    const streaming = (t: string) =>
      value([
        e(1, "user"),
        e(1, "assistant", { status: "streaming", parts: [{ type: "text", text: t }] }),
      ]);
    const el = await mount(streaming("Hel"), h.acc);
    const first = h.nodes.get("t1.assistant");
    const askedBefore = h.asked.filter((x) => x.id === "t1.assistant").length;
    for (const t of ["Hello", "Hello wo", "Hello world"]) {
      el.value = streaming(t);
      await settle(el);
    }
    expect(h.asked.filter((x) => x.id === "t1.assistant").length).toBe(askedBefore); // not re-asked per delta
    expect(article(el, 1, "assistant").querySelector("[data-entry-accessory] > section")).toBe(
      first
    );
    expect(first?.isConnected).toBe(true);

    el.value = value([e(1, "user"), e(1, "assistant")]); // the reply settles
    await settle(el);
    const last = h.asked.filter((x) => x.id === "t1.assistant").at(-1);
    expect(last?.status).toBe("complete");
    expect(article(el, 1, "assistant").querySelector("[data-entry-accessory] > section")).toBe(
      first
    );
    expect(first?.textContent).toBe("acc t1.assistant complete");
  });

  it("never asks for, or draws under, a restricted entry", async () => {
    const h = host();
    const el = await mount(
      value([e(1, "user"), e(1, "assistant", { status: "restricted", parts: undefined })]),
      h.acc
    );
    // the placeholder IS drawn (so this is not a refused value drawing nothing)
    expect(article(el, 1, "assistant")?.getAttribute("data-status")).toBe("restricted");
    expect(h.asked.some((x) => x.status === "restricted")).toBe(false);
    expect(root(el).querySelector("[data-entry-accessory]")).toBeNull();

    // an entry that BECOMES restricted loses what was drawn for it
    el.value = value([e(2, "assistant")]);
    await settle(el);
    expect(article(el, 2, "assistant").querySelector("[data-entry-accessory]")).not.toBeNull();
    el.value = value([e(2, "assistant", { status: "restricted", parts: undefined })]);
    await settle(el);
    expect(article(el, 2, "assistant")?.getAttribute("data-status")).toBe("restricted");
    expect(root(el).querySelector("[data-entry-accessory]")).toBeNull();
  });

  it("changed(id) asks again for that entry only; changed() for every entry", async () => {
    const h = host();
    const el = await mount(value([e(1, "assistant"), e(2, "assistant")]), h.acc);
    const count = (id: string) => h.asked.filter((x) => x.id === id).length;
    const [c1, c2] = [count("t1.assistant"), count("t2.assistant")];
    h.changed("t2.assistant");
    await settle(el);
    expect([count("t1.assistant"), count("t2.assistant")]).toEqual([c1, c2 + 1]);
    h.changed();
    await settle(el);
    expect([count("t1.assistant"), count("t2.assistant")]).toEqual([c1 + 1, c2 + 2]);
  });

  it("content that appears later: the host returns it once ready and says so", async () => {
    let ready = false;
    let changed: ((id?: string) => void) | undefined;
    const el = await mount(value([e(1, "assistant")]), {
      render: (entry) => (ready ? html`<p data-late>late for ${entry.id}</p>` : null),
      subscribe: (c) => {
        changed = c;
        return () => undefined;
      },
    });
    expect(root(el).querySelector("[data-entry-accessory]")).toBeNull();
    ready = true;
    changed?.("t1.assistant");
    await settle(el);
    expect(article(el, 1, "assistant").querySelector("[data-late]")?.textContent).toBe(
      "late for t1.assistant"
    );
  });

  it("unsubscribes when the widget leaves the page; a throwing host seam never breaks the transcript", async () => {
    const h = host();
    const el = await mount(value([e(1, "assistant")]), h.acc);
    el.remove();
    expect(h.unsubscribed).toBe(1);

    const broken = await mount(value([e(1, "user"), e(1, "assistant")]), {
      render: () => {
        throw new Error("host boom");
      },
      subscribe: () => {
        throw new Error("subscribe boom");
      },
    });
    expect(article(broken, 1, "assistant").textContent).toContain("assistant 1");
    expect(root(broken).querySelector("[data-entry-accessory]")).toBeNull();
  });

  it("draws nothing and asks nothing without the option", async () => {
    const el = await mount(value([e(1, "user"), e(1, "assistant")]));
    expect(root(el).querySelector("[data-entry-accessory]")).toBeNull();
  });
});
