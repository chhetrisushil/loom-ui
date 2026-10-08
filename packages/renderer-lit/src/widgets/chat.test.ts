import type { ChatValue } from "@loom-ui/core/chat";
import { EDIT_TURN_ACTION, LOAD_OLDER_ACTION, isSubmitKey } from "@loom-ui/core/chat";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./lu-chat";

// U8: the transcript widget. Everything in a turn is untrusted TEXT: it must never become an element,
// a restricted entry draws a bare placeholder, a failure is a fixed sentence, and a live reply is a
// polite log held aria-busy until it settles.

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
const widget = (props: Record<string, unknown> = {}) =>
  customWidget$({ kind: "Chat", id: "chat", title: "Support chat", binding: b, props });
const mount = async (
  value: unknown,
  props: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) => {
  const el = document.createElement("lu-chat") as Mounted;
  Object.assign(el, { widget: widget(props), value, ...extra });
  document.body.appendChild(el);
  await settle(el);
  return el;
};
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;
const q = <T extends Element>(el: HTMLElement, sel: string) =>
  root(el).querySelector(sel) as T | null;
const qa = (el: HTMLElement, sel: string) => [...root(el).querySelectorAll(sel)];

const text = (t: string) => [{ type: "text" as const, text: t }];
const e = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  id: `t${turn}.${role}`,
  turn,
  role,
  status: "complete",
  parts: text(`${role} ${turn}`),
  ...over,
});
const value = (entries: unknown[], more: Record<string, unknown> = {}) =>
  ({ entries, ...more }) as ChatValue;

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lu-chat: drawing a transcript", () => {
  it("draws speakers and text in order inside a polite, labelled log", async () => {
    const el = await mount(value([e(1, "user"), e(1, "assistant")]));
    const log = q(el, ".log");
    expect(log?.getAttribute("role")).toBe("log");
    expect(log?.getAttribute("aria-live")).toBe("polite");
    expect(log?.getAttribute("aria-busy")).toBe("false");
    expect(log?.getAttribute("aria-label")).toBe("Support chat");
    expect(log?.getAttribute("tabindex")).toBe("0"); // a scroll region a keyboard can reach
    const arts = qa(el, "article");
    expect(arts.map((a) => a.getAttribute("data-role"))).toEqual(["user", "assistant"]);
    expect(arts[0]?.getAttribute("aria-label")).toBe("You");
    expect(arts[1]?.getAttribute("aria-label")).toBe("Assistant");
    expect(arts[0]?.textContent).toContain("user 1");
  });

  it("untrusted text is TEXT: markup, handlers, script, links and images in a turn never become elements", async () => {
    const attacks = [
      '<img src=x onerror="window.__pwned=1">',
      "<script>window.__pwned=1</script>",
      '<a href="javascript:alert(1)">click</a>',
      "![x](https://evil.example/leak.png) [y](javascript:alert(1)) <iframe src=//evil></iframe>",
      "</p><p onclick=alert(1)>x",
      '"><svg onload=alert(1)>',
      "{{constructor.constructor('alert(1)')()}}",
      "<style>*{display:none}</style>",
    ];
    const el = await mount(
      value(attacks.map((a, i) => e(i + 1, "user", { id: `t${i + 1}.user`, parts: text(a) })))
    );
    for (const tag of ["img", "script", "a", "iframe", "svg", "style", "form", "input"])
      expect(qa(el, `.log ${tag}`), tag).toHaveLength(0);
    // every attack is on screen as its own literal text
    const shown = qa(el, "[data-text]").map((n) => n.textContent);
    expect(shown).toEqual(attacks);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    for (const n of qa(el, "[data-text]")) expect(n.children).toHaveLength(0);
  });

  it("FUZZ: no random text ever produces an element or an attribute inside a turn", async () => {
    let seed = 0xc0ffee;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pool = [
      "<",
      ">",
      "&",
      '"',
      "'",
      "`",
      "{{",
      "}}",
      "javascript:",
      "data:",
      "on",
      "x=",
      "/",
      "\\",
      "[",
      "](",
      "<b>",
      "&lt;",
      "\u202e",
      "\u001b[31m",
      "😀",
      "a",
      " ",
      "\n",
    ];
    const entries = Array.from({ length: 40 }, (_, i) => {
      let s = "";
      for (let j = 0; j < 30; j++) s += pool[Math.floor(rnd() * pool.length)];
      return e(i + 1, "user", { id: `t${i + 1}.user`, parts: text(s) });
    });
    const el = await mount(value(entries));
    for (const p of qa(el, "[data-text]")) {
      expect(p.children).toHaveLength(0);
      expect([...p.attributes].map((a) => a.name).sort()).toEqual(["class", "data-text"]);
      expect(p.textContent).not.toContain(String.fromCharCode(0x202e));
      expect(p.textContent).not.toContain(String.fromCharCode(27));
    }
    expect(
      qa(el, ".log *").every((n) =>
        ["ARTICLE", "HEADER", "SPAN", "P", "DIV", "BUTTON", "UL", "LI"].includes(n.tagName)
      )
    ).toBe(true);
  });

  it("text from a source that did not sanitise is cleaned again at render (escapes, bidi)", async () => {
    const el = await mount(value([e(1, "user", { parts: text("hi\u001b[2J\u202e evil") })]));
    expect(q(el, "[data-text]")?.textContent).toBe("hi[2J evil");
  });

  it("a RESTRICTED entry is a bare placeholder: no text, no tools, no reason, whatever the value carries", async () => {
    // (A value like this fails the contract and is never drawn: the widget shows its error state.)
    const bad = await mount(
      value([
        {
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "restricted",
          parts: text("TOP SECRET"),
        },
      ])
    );
    expect(root(bad).innerHTML).not.toContain("TOP SECRET");
    expect(q(bad, "[data-state='error']")).not.toBeNull();
    const ok = await mount(
      value([
        {
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "restricted",
          asker: { actor: "carol" },
          cursor: "0.3",
        },
      ])
    );
    const art = q(ok, "article");
    expect(art?.getAttribute("data-status")).toBe("restricted");
    expect(art?.getAttribute("aria-label")).toBe("Restricted message");
    expect(art?.textContent?.replace(/\s+/g, " ").trim()).toBe("Assistant Restricted");
    expect(art?.querySelectorAll("[data-text]")).toHaveLength(0);
  });

  it("failed / rejected turns say a FIXED sentence and a reference id; the source's text does not exist", async () => {
    const el = await mount(
      value([
        e(1, "assistant", {
          status: "failed",
          parts: undefined,
          reason: "model-error",
          errorId: "err-42",
        }),
        e(2, "user", { status: "rejected", parts: undefined, reason: "totally-unknown-token" }),
      ])
    );
    const fixed = qa(el, "[data-fixed]").map((n) => n.textContent?.replace(/\s+/g, " ").trim());
    expect(fixed).toEqual([
      "The assistant ran into a problem. (ref err-42)",
      "The message was not processed.",
    ]);
    expect(root(el).innerHTML).not.toContain("totally-unknown-token");
  });

  it("an interrupted reply shows its partial text and says so", async () => {
    const el = await mount(
      value([e(1, "assistant", { status: "interrupted", parts: text("The answer is") })])
    );
    const art = q(el, "article");
    expect(art?.getAttribute("aria-label")).toBe("Assistant, interrupted");
    expect(art?.textContent).toContain("The answer is");
    expect(art?.textContent).toContain("(interrupted)");
  });

  it("a streaming reply holds the log aria-busy, keeps its entry across the durable swap (no remount), and then settles", async () => {
    const el = await mount(
      value([e(1, "user"), e(1, "assistant", { status: "streaming", parts: text("Hel") })], {
        running: true,
      })
    );
    expect(q(el, ".log")?.getAttribute("aria-busy")).toBe("true");
    const live = q(el, "article[data-role='assistant']");
    expect(live?.textContent).toContain("Hel");
    expect(qa(el, ".caret")).toHaveLength(1);
    el.value = value(
      [e(1, "user"), e(1, "assistant", { status: "streaming", parts: text("Hello") })],
      { running: true }
    );
    await settle(el);
    expect(q(el, "article[data-role='assistant']")).toBe(live); // same node: text patched in place
    expect(live?.textContent).toContain("Hello");
    el.value = value([e(1, "user"), e(1, "assistant", { parts: text("Hello there") })]);
    await settle(el);
    expect(q(el, "article[data-role='assistant']")).toBe(live); // the durable entry reused the slot
    expect(q(el, ".log")?.getAttribute("aria-busy")).toBe("false");
    expect(qa(el, ".caret")).toHaveLength(0);
    expect(live?.textContent).toContain("Hello there");
  });

  it("shows a typing line only while a reply is pending and not yet streaming; closed conversations say so", async () => {
    const pending = await mount(value([e(1, "user")], { running: true }));
    expect(q(pending, ".typing")?.textContent).toBe("The assistant is replying…");
    const closed = await mount(value([e(1, "user")], { running: true, state: "closed" }));
    expect(q(closed, ".typing")?.textContent).toBe("");
    expect(q(closed, ".closed")?.textContent).toBe("This conversation is closed.");
    const empty = await mount(value([]), { emptyText: "Ask me anything" });
    expect(q(empty, ".empty")?.textContent).toBe("Ask me anything");
  });

  it("another asker is named and a bad value is the contract's error state, not a half-drawn log", async () => {
    const shared = await mount(
      value([e(1, "user", { asker: { actor: "alice" } })], { viewer: { actor: "bob" } })
    );
    expect(q(shared, "article")?.getAttribute("aria-label")).toBe("alice");
    expect(q(shared, "article[data-own]")).toBeNull();
    const bad = await mount({ entries: [{ nope: 1 }] });
    expect(q(bad, "[data-state='error']")).not.toBeNull();
    expect(q(bad, ".log")).toBeNull();
  });

  it("stays fast and bounded on a 500-turn transcript with 100 KB of adversarial text", async () => {
    const big = "<b>".repeat(15_000) + "\n".repeat(15_000);
    const entries = Array.from({ length: 500 }, (_, i) =>
      e(i + 1, "user", { id: `t${i + 1}.user`, parts: text(i === 0 ? big : "hello") })
    );
    const t0 = performance.now();
    const el = await mount(value(entries));
    const ms = performance.now() - t0;
    expect(qa(el, "article")).toHaveLength(500);
    expect(qa(el, "[data-text]")[0]?.textContent?.length).toBeLessThanOrEqual(65_536);
    expect(ms).toBeLessThan(5000);
  });
});

describe("lu-chat: media parts", () => {
  const ref = {
    address: "sha256:deadbeef0001",
    mediaType: "image/png",
    name: "plot.png",
    size: 2048,
  };
  it("are DESCRIBED (never loaded, never an address) when the media widgets are not registered", async () => {
    const el = await mount(
      value([e(1, "assistant", { parts: [{ type: "media", ref }, ...text("see above")] })])
    );
    const line = q(el, "[data-media-state='not-loaded']");
    expect(line?.textContent).toBe("image plot.png (image/png, 2 KiB)");
    expect(root(el).innerHTML).not.toContain("deadbeef");
    expect(qa(el, "img, audio, video, a, lu-image")).toHaveLength(0);
  });

  it("are drawn through the media widgets and the HOST's resolver when they are registered", async () => {
    await import("./lu-media");
    const asked: string[] = [];
    const resolver = async (r: { ref: { address: string } }) => {
      asked.push(r.ref.address);
      return { ok: true as const, url: "https://cdn.example.com/m/1" };
    };
    const el = await mount(
      value([e(1, "assistant", { parts: [{ type: "media", ref }] })]),
      {},
      { media: { resolver } }
    );
    const img = q(el, "lu-image") as Mounted | null;
    expect(img).not.toBeNull();
    await settle(img as Mounted);
    expect(asked).toEqual([ref.address]);
    expect(img?.shadowRoot?.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.example.com/m/1"
    );
    expect(root(el).innerHTML).not.toContain("deadbeef"); // the address is a property of the child, never markup
  });
});

describe("lu-chat: load earlier", () => {
  it("offers the button only when the value has an older cursor, and emits LOAD_OLDER with exactly that cursor", async () => {
    const actions: unknown[] = [];
    const none = await mount(value([e(1, "user")]));
    expect(q(none, "[data-older]")).toBeNull();
    const el = await mount(
      value([e(5, "user")], { older: "0.9" }),
      {},
      { onAction: (a: unknown) => void actions.push(a) }
    );
    const btn = q<HTMLButtonElement>(el, "[data-older]");
    expect(btn?.textContent).toBe("Load earlier messages");
    btn?.click();
    await settle(el);
    expect(actions).toEqual([
      { type: LOAD_OLDER_ACTION, widgetId: "chat", payload: { cursor: "0.9" } },
    ]);
    // one load in flight: a second click does nothing until new data arrives
    expect(q<HTMLButtonElement>(el, "[data-older]")?.disabled).toBe(true);
    q<HTMLButtonElement>(el, "[data-older]")?.click();
    await settle(el);
    expect(actions).toHaveLength(1);
    // a live message arriving meanwhile does not re-enable it (the same cursor is still being loaded)
    el.value = value([e(5, "user"), e(6, "user")], { older: "0.9" });
    await settle(el);
    expect(q<HTMLButtonElement>(el, "[data-older]")?.disabled).toBe(true);
    el.value = value([e(4, "user"), e(5, "user")], { older: "0.4" });
    await settle(el);
    expect(q<HTMLButtonElement>(el, "[data-older]")?.disabled).toBe(false);
  });

  it("hands focus to the log when the last page arrives and the button goes away", async () => {
    const el = await mount(
      value([e(5, "user")], { older: "0.9" }),
      {},
      { onAction: () => undefined }
    );
    q<HTMLButtonElement>(el, "[data-older]")?.click();
    await settle(el);
    q<HTMLButtonElement>(el, "[data-older]")?.focus();
    el.value = value([e(4, "user"), e(5, "user")]);
    await settle(el);
    expect(q(el, "[data-older]")).toBeNull();
    expect(root(el).activeElement).toBe(q(el, ".log"));
  });

  it("a refused load (the host answers ok:false) re-enables the button", async () => {
    const el = await mount(
      value([e(5, "user")], { older: "0.9" }),
      {},
      { onAction: async () => ({ ok: false, reason: "stale" }) }
    );
    q<HTMLButtonElement>(el, "[data-older]")?.click();
    await settle(el);
    expect(q<HTMLButtonElement>(el, "[data-older]")?.disabled).toBe(false);
  });
});

describe("lu-chat: edit a previous turn (a NEW turn, never a mutation)", () => {
  const thread = (more: Record<string, unknown> = {}) =>
    value(
      [
        e(1, "user", { parts: text("original question") }),
        e(1, "assistant"),
        e(2, "user", { asker: { actor: "alice" } }),
      ],
      { viewer: { actor: "bob" }, ...more }
    );

  it("Edit is offered only on the viewer's OWN complete turns, only when the node opts in, only with a handler", async () => {
    const mine = value(
      [e(1, "user"), e(1, "assistant"), e(2, "user", { status: "interrupted" })].map((x) => x),
      { viewer: { actor: "bob" } }
    );
    const onAction = () => undefined;
    const off = await mount(mine, {}, { onAction });
    expect(qa(off, "[data-edit-button]")).toHaveLength(0); // editable not set
    const noHandler = await mount(mine, { editable: true });
    expect(qa(noHandler, "[data-edit-button]")).toHaveLength(0);
    const on = await mount(mine, { editable: true }, { onAction });
    expect(qa(on, "[data-edit-button]").map((b) => b.getAttribute("data-edit-button"))).toEqual([
      "1",
    ]); // not the assistant's, not the interrupted one
    const other = await mount(thread(), { editable: true }, { onAction });
    expect(qa(other, "[data-edit-button]").map((b) => b.getAttribute("data-edit-button"))).toEqual([
      "1",
    ]); // alice's turn 2 is not bob's
    const closed = await mount(
      value([e(1, "user")], { state: "closed" }),
      { editable: true },
      { onAction }
    );
    expect(qa(closed, "[data-edit-button]")).toHaveLength(0);
  });

  it("opens an editor on the text, sends EDIT_TURN {turn,text,key} once, and leaves the drawn history untouched", async () => {
    const actions: Array<{ type: string; payload: { turn: number; text: string; key: string } }> =
      [];
    const el = await mount(
      thread(),
      { editable: true },
      { onAction: (a: never) => void actions.push(a) }
    );
    q<HTMLButtonElement>(el, "[data-edit-button='1']")?.click();
    await settle(el);
    const field = q<HTMLTextAreaElement>(el, "[data-edit-field]");
    expect(field?.value).toBe("original question");
    expect(root(el).activeElement).toBe(field); // focus moves into the editor
    field!.value = "better question";
    field!.dispatchEvent(new Event("input"));
    field!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })
    );
    await settle(el);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe(EDIT_TURN_ACTION);
    expect(actions[0]?.payload).toMatchObject({ turn: 1, text: "better question" });
    expect(isSubmitKey(actions[0]?.payload.key)).toBe(true);
    // the editor closed on success; the original turn is still there, unchanged
    expect(q(el, "[data-editor]")).toBeNull();
    expect(qa(el, "[data-text]")[0]?.textContent).toBe("original question");
  });

  it("a failed edit keeps the editor and its text, and the retry carries the SAME key", async () => {
    const keys: string[] = [];
    let ok = false;
    const el = await mount(
      thread(),
      { editable: true },
      {
        onAction: async (a: { payload: { key: string } }) => {
          keys.push(a.payload.key);
          return ok ? { ok: true } : { ok: false, reason: "failed" };
        },
      }
    );
    q<HTMLButtonElement>(el, "[data-edit-button='1']")?.click();
    await settle(el);
    const send = () => qa(el, ".editor button")[0] as HTMLButtonElement;
    send().click();
    await settle(el);
    expect(q(el, "[data-editor]")).not.toBeNull();
    expect(q(el, "#edit-status")?.textContent).toBe("Not sent. Try again.");
    ok = true;
    send().click();
    await settle(el);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(q(el, "[data-editor]")).toBeNull();
  });

  it("Escape cancels and returns focus to the Edit button; nothing is sent", async () => {
    const actions: unknown[] = [];
    const el = await mount(
      thread(),
      { editable: true },
      { onAction: (a: unknown) => void actions.push(a) }
    );
    q<HTMLButtonElement>(el, "[data-edit-button='1']")?.click();
    await settle(el);
    q(el, "[data-edit-field]")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    await settle(el);
    expect(q(el, "[data-editor]")).toBeNull();
    expect(root(el).activeElement).toBe(q(el, "[data-edit-button='1']"));
    expect(actions).toEqual([]);
  });

  it("a blank edit is refused client-side; an edited turn that arrives is drawn as an edit of the earlier one", async () => {
    const actions: unknown[] = [];
    const el = await mount(
      thread(),
      { editable: true },
      { onAction: (a: unknown) => void actions.push(a) }
    );
    q<HTMLButtonElement>(el, "[data-edit-button='1']")?.click();
    await settle(el);
    const f = q<HTMLTextAreaElement>(el, "[data-edit-field]") as HTMLTextAreaElement;
    f.value = "   ";
    f.dispatchEvent(new Event("input"));
    (qa(el, ".editor button")[0] as HTMLButtonElement).click();
    await settle(el);
    expect(actions).toEqual([]);
    expect(q(el, "#edit-status")?.textContent).toBe("Type a message first.");
    (qa(el, ".editor button")[1] as HTMLButtonElement).click(); // Cancel
    await settle(el);
    el.value = value([e(1, "user"), e(1, "assistant"), e(2, "user", { editOf: 1 })], {
      viewer: { actor: "bob" },
    });
    await settle(el);
    expect(q(el, "article[data-turn='2']")?.getAttribute("aria-label")).toBe("You, edit of turn 1");
    expect(qa(el, "[data-text]")[0]?.textContent).toBe("user 1"); // the earlier turn is still there
  });
});

describe("parity with the terminal surface", () => {
  it("the web and the terminal speak the same words for the same transcript (shared speaker, note and fixed sentences)", async () => {
    const { chatTranscriptLines } = await import("@loom-ui/core/chat");
    const v = value(
      [
        e(1, "user"),
        e(1, "assistant", { status: "interrupted", parts: text("par") }),
        e(2, "user", { editOf: 1 }),
        e(2, "assistant", {
          status: "failed",
          parts: undefined,
          reason: "model-error",
          errorId: "err-7",
        }),
        e(3, "user", { status: "rejected", parts: undefined, reason: "stale" }),
        e(3, "assistant", { status: "restricted", parts: undefined }),
        e(4, "user", { asker: { actor: "alice" } }),
        e(4, "assistant", { status: "streaming", parts: text("Thi") }),
      ],
      { viewer: { actor: "me" } }
    );
    // (turn 4 is someone else's in shared mode; turns 1-3 carry no asker so they are the viewer's own)
    const el = await mount(v);
    const web = qa(el, "article").map((a) => {
      const who = a.querySelector(".who")?.textContent ?? "";
      const note = a.querySelector(".note")?.textContent ?? "";
      const body = [...a.querySelectorAll("[data-text], [data-fixed]")]
        .map((n) => n.textContent?.replace(/\s+/g, " ").trim())
        .join(" ");
      return a.getAttribute("data-status") === "restricted"
        ? "[restricted]"
        : `${who}${note === "" ? "" : ` ${note}`}: ${body}`.trimEnd();
    });
    const terminal = chatTranscriptLines(v).map((l) =>
      l.startsWith("[restricted") ? "[restricted]" : l
    );
    expect(web).toEqual(terminal);
  });
});
