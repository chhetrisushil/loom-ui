import { describe, expect, it } from "vitest";
import { checkKindValue } from "./browser";
import * as chat from "./chat";
import { ChatFeed } from "./chatFeed";
import * as chatUi from "./chatUi";
import { isChatValue } from "./chatValue";
import * as main from "./index";

const part = (over: Record<string, unknown> = {}) => ({
  type: "text",
  text: "Due in **30 days**.",
  ...over,
});
const entry = (role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  id: role === "user" ? "m1" : "t1.assistant",
  turn: 1,
  role,
  status: "complete",
  parts: [part()],
  ...over,
});
const value = (...entries: unknown[]) => ({ entries });

describe("a text part's format", () => {
  it("is plain when absent, and may say plain or markdown on an assistant entry", () => {
    expect(isChatValue(value(entry("assistant")))).toBe(true);
    expect(isChatValue(value(entry("assistant", { parts: [part({ format: "plain" })] })))).toBe(
      true
    );
    expect(isChatValue(value(entry("assistant", { parts: [part({ format: "markdown" })] })))).toBe(
      true
    );
    expect(
      checkKindValue("Chat", value(entry("assistant", { parts: [part({ format: "markdown" })] })))
        .ok
    ).toBe(true);
  });
  it.each([
    ["an unknown format", entry("assistant", { parts: [part({ format: "html" })] })],
    ["a non-string format", entry("assistant", { parts: [part({ format: true })] })],
    ["markdown on a user entry", entry("user", { parts: [part({ format: "markdown" })] })],
    [
      "a stray field next to format",
      entry("assistant", { parts: [part({ format: "markdown", html: "<b>" })] }),
    ],
  ])("refuses %s", (_name, e) => expect(checkKindValue("Chat", value(e)).ok).toBe(false));
  it("refuses a format on a restricted placeholder, which carries no parts at all", () => {
    expect(
      checkKindValue(
        "Chat",
        value({
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "restricted",
          parts: [part({ format: "markdown" })],
        })
      ).ok
    ).toBe(false);
  });
});

describe("ChatFeed({ markdown: true })", () => {
  const wire = (
    turn: number,
    role: "user" | "assistant",
    text: string,
    over: Record<string, unknown> = {}
  ) => ({
    turn,
    role,
    text,
    status: "complete",
    cursor: `1.${turn * 2 + (role === "user" ? 0 : 1)}`,
    ...over,
  });
  const fed = (opts: { markdown?: boolean }) => {
    const f = new ChatFeed(opts);
    f.applyHistory(
      {
        entries: [wire(1, "assistant", "Due **now**", {}), wire(1, "user", "q **x**")],
        done: true,
      },
      "backward"
    );
    return f;
  };
  it("marks an assistant reply's text, and never a person's own turn", () => {
    const v = fed({ markdown: true }).value();
    expect(
      v.entries.map((e) => [
        e.role,
        e.parts?.map((p) => (p.type === "text" ? p.format : undefined)),
      ])
    ).toEqual([
      ["user", [undefined]],
      ["assistant", ["markdown"]],
    ]);
    expect(isChatValue(v)).toBe(true);
  });
  it("leaves the value exactly as it was when the option is off", () => {
    const v = fed({}).value();
    expect(JSON.stringify(v)).not.toContain("format");
    expect(JSON.stringify(fed({ markdown: false }).value())).toBe(JSON.stringify(v));
  });
  it("marks the reply while it streams too, so the same renderer path settles it", () => {
    const f = new ChatFeed({ markdown: true });
    f.applyEvent("delta", { turn: 1, text: "Due **no" });
    const live = f.value().entries.find((e) => e.status === "streaming");
    expect(live?.parts).toEqual([{ type: "text", text: "Due **no", format: "markdown" }]);
    expect(isChatValue(f.value())).toBe(true);
  });
  it("marks nothing on a restricted or failed turn that has no text", () => {
    const f = new ChatFeed({ markdown: true });
    f.applyHistory(
      {
        entries: [
          wire(1, "assistant", "x", { status: "restricted" }),
          wire(2, "assistant", "", { status: "failed", reason: "model-error" }),
        ],
        done: true,
      },
      "backward"
    );
    expect(JSON.stringify(f.value())).not.toContain("markdown");
  });
});

describe("the markdown exports", () => {
  it("chat-ui, chat and the main entry export the parser, and never the test-only meter", () => {
    for (const e of [chatUi, chat, main] as Record<string, unknown>[]) {
      for (const n of [
        "parseChatMarkdown",
        "resolveMdMarkers",
        "mdPlainText",
        "safeLinkHref",
        "MD_MAX_NODES",
      ])
        expect(typeof e[n], n).not.toBe("undefined");
      expect(Object.keys(e).filter((k) => /Metered/i.test(k))).toEqual([]);
    }
  });
});
