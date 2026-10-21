import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHAT_REF_OPEN_ACTION,
  MD_MAX_DEPTH,
  MD_MAX_INLINE_DEPTH,
  MD_MAX_NODES,
  parseChatMarkdown,
} from "@loom-ui/core/chat-ui";
import { customWidget$ } from "@loom/blueprint-runtime";
import { nothing, render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-chat";
import { drawMarkdown } from "./chatMarkdown";

const b = { projectionId: "hydration", path: "values.h" };
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
type El = HTMLElement & { updateComplete: Promise<unknown> };
async function mount(value: unknown, onAction?: (a: unknown) => unknown): Promise<El> {
  const el = document.createElement("lu-chat") as El;
  Object.assign(el, {
    widget: customWidget$({ kind: "Chat", id: "chat", title: "t", binding: b, props: {} }),
    value,
    onAction,
  });
  document.body.appendChild(el);
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
  return el;
}
const part = (text: string, format?: string) => ({ type: "text", text, ...(format && { format }) });
const reply = (text: string, over: Record<string, unknown> = {}, format = "markdown") => ({
  id: "t1.assistant",
  turn: 1,
  role: "assistant",
  status: "complete",
  parts: [part(text, format)],
  ...over,
});
const md = (el: El) =>
  el.shadowRoot?.querySelector("article[data-role='assistant'] .md") as HTMLElement;
const all = (root: Element) => [root, ...root.querySelectorAll("*")];

describe("lu-chat, a markdown part", () => {
  it("draws structure as elements, and the text of every node as text", async () => {
    const el = await mount({
      entries: [
        reply(
          "# Terms\n\nDue in **30 days** and `net`.\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n---\n\n```ts\nlet a = 1 < 2;\n```"
        ),
      ],
    });
    const root = md(el);
    expect(root.getAttribute("data-format")).toBe("markdown");
    expect(root.querySelector("[role=heading]")?.getAttribute("aria-level")).toBe("3");
    expect(root.querySelector("strong")?.textContent).toBe("30 days");
    expect(root.querySelector("p code")?.textContent).toBe("net");
    expect([...root.querySelectorAll("ul > li")].map((x) => x.textContent?.trim())).toEqual([
      "one",
      "two",
    ]);
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
    expect(root.querySelector("blockquote")?.textContent?.trim()).toBe("quoted");
    expect(root.querySelector("hr")).not.toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe("let a = 1 < 2;");
    expect(root.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
  });
  it("draws a table with scoped headers and alignment, in a focusable, named region", async () => {
    const el = await mount({ entries: [reply("| item | qty |\n|:--|--:|\n| nut | 4 |")] });
    const region = md(el).querySelector(".table") as HTMLElement;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Table 1");
    expect(
      [...region.querySelectorAll("th")].map((x) => [
        x.textContent,
        x.getAttribute("scope"),
        x.getAttribute("data-align"),
      ])
    ).toEqual([
      ["item", "col", "left"],
      ["qty", "col", "right"],
    ]);
    expect([...region.querySelectorAll("td")].map((x) => x.textContent)).toEqual(["nut", "4"]);
  });
  it("shows html as the characters, and never makes an element the parser did not", async () => {
    const el = await mount({
      entries: [reply('<b>raw</b> <img src=x onerror="alert(1)"> <script>alert(1)</script> &amp;')],
    });
    const root = md(el);
    expect(root.textContent).toContain(
      '<b>raw</b> <img src=x onerror="alert(1)"> <script>alert(1)</script> &amp;'
    );
    expect(all(root).map((n) => n.localName)).toEqual(["div", "p"]);
  });
  it("links only allowed addresses, in a new context with no opener and no referrer, and shows the address", async () => {
    const el = await mount({
      entries: [
        reply(
          "[a](https://example.com/x?y=1) [b](javascript:alert(1)) [c](mailto:a@b.example) [d](data:text/html,x) ![e](https://tracker.example/p.png)"
        ),
      ],
    });
    const links = [...md(el).querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/x?y=1",
      "mailto:a@b.example",
    ]);
    for (const a of links) {
      // a mailto link opens the mail client, not an empty tab
      if (a.getAttribute("href")?.startsWith("mailto:"))
        expect(a.hasAttribute("target")).toBe(false);
      else expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      expect(a.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(a.getAttribute("title")).toBe(a.getAttribute("href"));
    }
    // The destination is shown after the label (so a label cannot pass for another site), not only in a tooltip.
    expect([...md(el).querySelectorAll("a .dest")].map((x) => x.textContent)).toEqual([
      " (example.com)",
      " (b.example)",
    ]);
    expect(md(el).textContent).toContain(
      "a (example.com) (opens in a new tab) b c (b.example) d e"
    );
    expect(md(el).querySelector("img")).toBeNull();
    expect(md(el).innerHTML).not.toContain("tracker.example");
  });
  it("never produces a tag, attribute or address outside the closed list, for hostile input", async () => {
    const hostile = [
      "[x](javascript:alert(1)) <a href=javascript:alert(1)>y</a> [[a1]] **<img src=x onerror=alert(1)>**",
      "```<script>\n</script>\n```\n\n> <iframe src=//evil.example></iframe>\n\n| <b> |\n|-|\n| <svg onload=alert(1)> |",
      '[click](https://evil.example/" onmouseover="alert(1))  [z](https://a.example/<b>)',
      "[a](JaVaScRiPt:alert(1)) [b](DATA:text/html,x) [c](vbscript:x) [d](&#106;avascript:alert(1)) [e](java\nscript:alert(1)) [f](//evil.example) [g](HTTPS://u:p@evil.example)",
      '[x" onclick="y](https://e.example/\' onmouseover=\'z) [<img src=x onerror=1>](https://e.example/><script>) [`a"b`](https://e.example/?q="><svg onload=1>)',
      `${String.fromCharCode(27)}[2J${String.fromCharCode(0x202e)} [a](https://e.example/${String.fromCharCode(0)}) \`${String.fromCharCode(7)}\``,
    ];
    const TAGS = new Set([
      "div",
      "p",
      "em",
      "strong",
      "code",
      "a",
      "br",
      "pre",
      "blockquote",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
      "button",
      "span",
    ]);
    const ATTRS = new Set([
      "class",
      "role",
      "aria-level",
      "aria-label",
      "tabindex",
      "data-lang",
      "data-align",
      "data-text",
      "data-format",
      "data-ref",
      "href",
      "title",
      "target",
      "rel",
      "referrerpolicy",
      "start",
      "scope",
      "type",
      "aria-disabled",
      "aria-hidden",
    ]);
    for (const text of hostile) {
      const el = await mount({
        refMarkers: true,
        entries: [reply(text, { refs: [{ id: "a1" }] })],
      });
      for (const n of all(md(el))) {
        expect(TAGS.has(n.localName), n.localName).toBe(true);
        for (const a of n.getAttributeNames()) expect(ATTRS.has(a), a).toBe(true);
        if (n.localName === "a")
          expect(n.getAttribute("href")).toMatch(/^(https?:\/\/[^\s@/]+|mailto:\S+)/i);
      }
      const shown = md(el).textContent ?? "";
      const bad = [...shown].filter((ch) => {
        const c = ch.charCodeAt(0);
        return (c < 32 && c !== 9 && c !== 10) || c === 0x202e;
      });
      expect(bad).toEqual([]);
    }
  });
  it("draws a part with no format, or a person's turn, exactly as typed", async () => {
    const el = await mount({
      entries: [
        {
          id: "m1",
          turn: 1,
          role: "user",
          status: "complete",
          parts: [part("**u** [x](https://e.example)")],
        },
        reply("**a** [x](https://e.example)", {}, ""),
      ],
    });
    expect(el.shadowRoot?.querySelector(".md")).toBeNull();
    expect(
      [...(el.shadowRoot as ShadowRoot).querySelectorAll("p.text")].map((p) => p.textContent)
    ).toEqual(["**u** [x](https://e.example)", "**a** [x](https://e.example)"]);
    expect(el.shadowRoot?.querySelector("a")).toBeNull();
  });
  it("a person's turn that claims markdown is refused by the contract, and nothing of it is drawn", async () => {
    const el = await mount({
      entries: [
        {
          id: "m1",
          turn: 1,
          role: "user",
          status: "complete",
          parts: [part("secret-user-md", "markdown")],
        },
      ],
    });
    expect(el.shadowRoot?.textContent).not.toContain("secret-user-md");
  });
  it("defence in depth: should a user part carrying markdown reach the component, it is drawn as plain text", async () => {
    const el = await mount({ entries: [reply("x")] });
    const host = document.createElement("div");
    const entry = { id: "m1", turn: 1, role: "user", status: "complete" };
    const text = "**u** [x](https://e.example) <b>";
    render(
      (el as unknown as { textPart: (e: unknown, p: unknown, v: unknown) => unknown }).textPart(
        entry,
        part(text, "markdown"),
        {}
      ) as never,
      host
    );
    expect(host.querySelector(".md")).toBeNull();
    expect(host.querySelector("a, strong, b")).toBeNull();
    expect(host.textContent).toBe(text);
  });
  const linkTexts = async (text: string) => {
    const el = await mount({ entries: [reply(text)] });
    return [...md(el).querySelectorAll("a")].map(
      (a) => a.querySelector(".dest")?.textContent ?? null
    );
  };
  it("shows the host unless the label IS that site (same host after normalisation, or the full address)", async () => {
    expect(await linkTexts("[bank.example](https://evil.example/login)")).toEqual([
      " (evil.example)",
    ]);
    expect(await linkTexts("[https://bank.example/?evil.example](https://evil.example/)")).toEqual([
      " (evil.example)",
    ]);
    expect(await linkTexts("[data.com](https://a.co/)")).toEqual([" (a.co)"]);
    expect(await linkTexts("[evil.example.bank.example](https://bank.example/)")).toEqual([
      " (bank.example)",
    ]);
    expect(await linkTexts("[example.com](https://example.com/x)")).toEqual([null]);
    expect(await linkTexts("[WWW.Example.com](https://example.com/x)")).toEqual([null]);
    expect(await linkTexts("[https://example.com/x?y=1](https://example.com/x?y=1)")).toEqual([
      null,
    ]);
    expect(await linkTexts("[http://example.com/other](https://example.com/x)")).toEqual([null]);
  });
  it("shows an international host in punycode, and one address for mailto", async () => {
    expect(await linkTexts("[x](https://b\u00fccher.example/)")).toEqual([
      " (xn--bcher-kva.example)",
    ]);
    expect(await linkTexts("[x](mailto:a@b\u00fccher.example)")).toEqual([
      " (xn--bcher-kva.example)",
    ]);
    // several addresses: no link is made, the label stays as text
    const el = await mount({
      entries: [
        reply(
          "[m](mailto:a@evil.example,b@bank.example) [n](mailto:a@x.example;b@y.example) [o](mailto:a%2Cb@y.example) [p](mailto:a%3Bb@y.example) [q](mailto:a@x.example?CC=b@y.example) [r](mailto:a@x.example?bcc=b@y.example) [s](mailto:a@x.example?to=b@y.example)"
        ),
      ],
    });
    expect(md(el).querySelector("a")).toBeNull();
    expect(md(el).textContent).toContain("m n o p q r s");
  });
  it("names each table, each code block, and announces cut-short text and new tabs", async () => {
    const el = await mount({
      entries: [reply("|a|\n|-|\n|1|\n\n|b|\n|-|\n|2|\n\n```\nx\n```\n\n[l](https://e.example)")],
    });
    expect([...md(el).querySelectorAll(".table")].map((x) => x.getAttribute("aria-label"))).toEqual(
      ["Table 1", "Table 2"]
    );
    expect(md(el).querySelector("pre")?.getAttribute("aria-label")).toBe("Code");
    expect(md(el).querySelector("a .sr-only")?.textContent).toBe(" (opens in a new tab)");
    const cut = await mount({
      entries: [reply("**a** [b](https://e.example) `c`\n\n".repeat(1800))],
    });
    expect(md(cut).querySelector("p.cut .sr-only")?.textContent).toBe("(reply cut short)");
  });
  it("draws a huge input cut short: bounded elements and an unspoken ellipsis", async () => {
    const el = await mount({
      entries: [reply("**a** [b](https://e.example) `c`\n\n".repeat(1800))],
    });
    const n = all(md(el)).length;
    expect(n).toBeLessThanOrEqual(MD_MAX_NODES * 3 + 50);
    expect(md(el).querySelector("p.cut")).not.toBeNull();
  });
});

describe("lu-chat, markdown and reference markers", () => {
  const refs = [{ id: "a1" }, { id: "b2" }];
  it("draws a listed marker as the same numbered button, inside any markup but a code span, a code block or a link", async () => {
    const seen: unknown[] = [];
    const el = await mount(
      {
        refMarkers: true,
        entries: [
          reply(
            "**Due [[b2]]** and _net_ [[a1]] [[zzz]]\n\n- item [[a1]]\n\nSee `[[a1]]` and [t [[a1]]](https://e.example)\n\n```\n[[a1]]\n```",
            { refs }
          ),
        ],
      },
      (a) => void seen.push(a)
    );
    const buttons = [...md(el).querySelectorAll<HTMLButtonElement>("button.ref")];
    expect(
      buttons.map((x) => [x.textContent, x.getAttribute("aria-label"), x.getAttribute("data-ref")])
    ).toEqual([
      ["1", "Source 1", "b2"],
      ["2", "Source 2", "a1"],
      ["2", "Source 2", "a1"],
    ]);
    expect(md(el).querySelector("strong button.ref")).not.toBeNull();
    expect(md(el).querySelector("code")?.textContent).toBe("[[a1]]");
    expect(md(el).querySelector("pre code")?.textContent).toBe("[[a1]]");
    expect(md(el).querySelector("a button")).toBeNull();
    expect(md(el).textContent).not.toContain("zzz");
    buttons[1]?.click();
    expect(seen).toEqual([
      {
        type: CHAT_REF_OPEN_ACTION,
        widgetId: "chat",
        payload: { entryId: "t1.assistant", refId: "a1", n: 2 },
      },
    ]);
  });
  it("hides every marker, and a half-written one, while the reply streams, and does not show a half-written markup", async () => {
    const el = await mount({
      refMarkers: true,
      entries: [reply("Due **in 30** [[a1]] and [the d", { status: "streaming", refs })],
    });
    expect(md(el).querySelectorAll("button.ref")).toHaveLength(0);
    expect(md(el).textContent).not.toContain("[[");
    expect(md(el).querySelector("strong")?.textContent).toBe("in 30");
    expect(md(el).querySelector(".caret")).not.toBeNull();
    expect(md(el).textContent).toContain("the d");
    const half = await mount({
      refMarkers: true,
      entries: [reply("Due [[a1", { status: "streaming", refs })],
    });
    expect(md(half).textContent?.trim()).toBe("Due");
  });
  it("settles when the durable reply replaces the live one: the same node set, now with its markers", async () => {
    const el = (await mount({
      refMarkers: true,
      entries: [reply("Due **now** [[a1]]", { status: "streaming", refs })],
    })) as El & { value: unknown };
    expect(md(el).querySelectorAll("button.ref")).toHaveLength(0);
    el.value = { refMarkers: true, entries: [reply("Due **now** [[a1]]", { refs })] };
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await el.updateComplete;
    }
    expect(md(el).querySelectorAll("button.ref")).toHaveLength(1);
    expect(md(el).querySelector(".caret")).toBeNull();
  });
  it("leaves [[id]] as text when the source does not write markers", async () => {
    const el = await mount({ entries: [reply("Due [[a1]].", { refs })] });
    expect(md(el).querySelectorAll("button.ref")).toHaveLength(0);
    expect(md(el).textContent).toContain("[[a1]]");
  });
});

describe("the markdown renderer's source", () => {
  it("never reaches for HTML-parsing APIs", () => {
    for (const f of ["chatMarkdown.ts", "lu-chat.ts"]) {
      const src = readFileSync(resolve(__dirname, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(
        /unsafe[A-Z]\w*|static-html|unsafe-html|unsafe-svg|innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write|DOMParser|\.setAttribute\(\s*["']on|style=/
      );
    }
  });
});

describe("drawMarkdown re-checks what it draws (hand-built nodes, no parser)", () => {
  const ref = (): never => nothing as never;
  const draw = (doc: unknown): HTMLElement => {
    const host = document.createElement("div");
    render(drawMarkdown(doc as never, { ref }), host);
    return host;
  };
  const para = (...inlines: unknown[]) => ({ type: "paragraph", inlines });
  const text = (t: string) => ({ type: "text", text: t });
  const link = (href: unknown) => ({ type: "link", href, children: [text("L")] });
  it("never makes a link of an address the link rule refuses", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " https://x.example",
      "//x.example",
      "data:text/html,x",
      "https://u@x.example",
      "https://x.example/a b",
      "ftp://x.example",
      "",
      undefined,
      42,
      { toString: () => "https://x.example" },
    ]) {
      const host = draw({ blocks: [para(link(href))], truncated: false });
      expect(host.querySelector("a"), String(href)).toBeNull();
      expect(host.textContent).toBe("L");
    }
    expect(
      draw({ blocks: [para(link("https://x.example/"))], truncated: false }).querySelector("a")
    ).not.toBeNull();
  });
  it("draws a forged tree with shared children (a DAG) within a fixed node budget", () => {
    let inl: unknown = text("shared-leaf ");
    let blk: unknown = para(inl);
    for (let k = 0; k < 6; k++) {
      inl = { type: "em", children: Array(8).fill(inl) };
      blk = { type: "list", ordered: false, items: Array(8).fill([blk]) };
    }
    const a = draw({ blocks: [para(inl)], truncated: false });
    const b = draw({ blocks: [blk], truncated: false });
    for (const host of [a, b]) {
      const n = (host.textContent ?? "").split("shared-leaf").length - 1;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(4000);
    }
  });
  it("draws a forged quote chain thousands deep without throwing, bounded", () => {
    let node: unknown = para(text("deep-leaf"));
    for (let k = 0; k < 5000; k++) node = { type: "quote", blocks: [node] };
    const host = draw({ blocks: [node], truncated: false });
    expect(host.querySelectorAll("blockquote").length).toBeLessThanOrEqual(16);
  });
  it("draws a maximum-depth PARSED document in full under the depth cap", () => {
    const em = ["*", "**"];
    let inner = "leaf";
    for (let k = MD_MAX_INLINE_DEPTH; k >= 1; k--)
      inner = `${em[k % 2]}${k} ${inner} ${k}${em[k % 2]}`;
    const text = `${"> ".repeat(MD_MAX_DEPTH)}${inner}`;
    const doc = parseChatMarkdown(text);
    const depthOf = (n: unknown): number => {
      const x = n as { blocks?: unknown[]; inlines?: unknown[]; children?: unknown[] };
      const kids = x.blocks ?? x.inlines ?? x.children ?? [];
      return 1 + Math.max(0, ...kids.map(depthOf));
    };
    const total = Math.max(...doc.blocks.map(depthOf)); // quotes, paragraph and inline levels, combined
    expect(total).toBeGreaterThanOrEqual(MD_MAX_DEPTH + MD_MAX_INLINE_DEPTH);
    const count = (n: unknown, tag: string): number => {
      const x = n as {
        type?: string;
        blocks?: unknown[];
        inlines?: unknown[];
        children?: unknown[];
      };
      const kids = x.blocks ?? x.inlines ?? x.children ?? [];
      return (x.type === tag ? 1 : 0) + kids.reduce<number>((a, k) => a + count(k, tag), 0);
    };
    const host = draw(doc);
    expect(count(doc.blocks[0], "quote")).toBe(MD_MAX_DEPTH);
    expect(host.querySelectorAll("blockquote")).toHaveLength(MD_MAX_DEPTH);
    const marks = count(doc.blocks[0], "em") + count(doc.blocks[0], "strong");
    expect(marks).toBeGreaterThanOrEqual(MD_MAX_INLINE_DEPTH - 1);
    expect(host.querySelectorAll("em, strong")).toHaveLength(marks);
    expect(host.textContent).toContain("leaf");
  });
  it("clamps or drops every other attribute value", () => {
    const host = draw({
      truncated: false,
      blocks: [
        { type: "heading", level: 99, inlines: [text("h")] },
        { type: "heading", level: '1" onclick="x', inlines: [text("h")] },
        { type: "code", lang: '"><x onmouseover=1', text: "c" },
        { type: "code", lang: "ts", text: "c" },
        { type: "list", ordered: true, start: '1" onclick="x', items: [[para(text("i"))]] },
        {
          type: "table",
          align: ["x", "right", 'left" onclick="y', null],
          head: [[text("a")], [text("b")], [text("c")], [text("d")]],
          rows: [],
        },
      ],
    });
    const heads = [...host.querySelectorAll("[role=heading]")];
    expect(heads.map((h) => h.getAttribute("aria-level"))).toEqual(["6", "6"]);
    expect(heads.map((h) => h.className)).toEqual(["h h6", "h h6"]);
    expect([...host.querySelectorAll("code")].map((c) => c.getAttribute("data-lang"))).toEqual([
      null,
      "ts",
    ]);
    expect(host.querySelector("ol")?.getAttribute("start")).toBe("1");
    expect([...host.querySelectorAll("th")].map((c) => c.getAttribute("data-align"))).toEqual([
      null,
      "right",
      null,
      null,
    ]);
    for (const n of [host, ...host.querySelectorAll("*")])
      for (const a of n.getAttributeNames()) expect(a.startsWith("on"), a).toBe(false);
  });
  it("draws an unknown or malformed node as nothing and never throws", () => {
    const host = draw({
      truncated: false,
      blocks: [
        { type: "script", text: "x" },
        null,
        42,
        para(
          { type: "img", src: "x" },
          null,
          { type: "text", text: { _$litType$: 1, strings: ["<b>"], values: [] } },
          text("ok")
        ),
        { type: "list", ordered: false, start: 1, items: "nope" },
        { type: "quote", blocks: undefined },
      ],
    });
    expect(host.querySelector("b, img, script")).toBeNull();
    expect(host.textContent).toContain("ok");
  });
});
