import { describe, expect, it } from "vitest";
import { checkKindValue } from "./browser";
import { ChatFeed } from "./chatFeed";
import { CHAT_REF_OPEN_ACTION, splitRefMarkers } from "./chatRefs";

const ids = new Set(["a1", "b2"]);
const seg = (text: string, o = { hideAll: false }) => splitRefMarkers(text, ids, o);

describe("splitRefMarkers", () => {
  it("names the action", () => expect(CHAT_REF_OPEN_ACTION).toBe("CHAT_REF_OPEN"));
  it("turns a listed marker into a numbered reference, by first appearance of the id", () => {
    expect(seg("Due in 30 days [[b2]] and net [[a1]], again [[b2]].")).toEqual([
      { type: "text", text: "Due in 30 days " },
      { type: "ref", id: "b2", n: 1 },
      { type: "text", text: " and net " },
      { type: "ref", id: "a1", n: 2 },
      { type: "text", text: ", again " },
      { type: "ref", id: "b2", n: 1 },
      { type: "text", text: "." },
    ]);
  });
  it("removes a marker that is not listed, with the one space before it", () => {
    expect(seg("Net 30 [[zzz]].")).toEqual([{ type: "text", text: "Net 30." }]);
    expect(seg("[[zzz]]x")).toEqual([{ type: "text", text: "x" }]);
  });
  it("leaves text that merely looks like a marker alone (spaces, empty, too long, wrong characters)", () => {
    const odd = ["[[]]", "[[ a1 ]]", "[a1]", `[[${"a".repeat(129)}]]`, "[[a b]]"];
    for (const t of odd) expect(seg(t)).toEqual([{ type: "text", text: t }]);
  });
  it("hides every marker, and a marker that has not finished arriving, while streaming", () => {
    expect(seg("Due [[a1]] in 30 [[b2", { hideAll: true })).toEqual([
      { type: "text", text: "Due in 30" },
    ]);
    expect(seg("Due [[", { hideAll: true })).toEqual([{ type: "text", text: "Due" }]);
    expect(seg("Due [", { hideAll: true })).toEqual([{ type: "text", text: "Due [" }]);
  });
  it("is linear on adversarial input", () => {
    const t = "[[".repeat(50_000);
    const start = Date.now();
    splitRefMarkers(t, ids, { hideAll: true });
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("refs on an entry and the feed", () => {
  const entry = (over: Record<string, unknown>) => ({
    entries: [
      {
        id: "t1.assistant",
        turn: 1,
        role: "assistant",
        status: "complete",
        parts: [{ type: "text", text: "x [[a1]]" }],
        ...over,
      },
    ],
    refMarkers: true,
  });
  it("accepts a list of unique ids on an assistant entry", () =>
    expect(checkKindValue("Chat", entry({ refs: [{ id: "a1" }, { id: "b2" }] })).ok).toBe(true));
  it.each([
    ["a duplicate id", entry({ refs: [{ id: "a1" }, { id: "a1" }] })],
    ["a bad id", entry({ refs: [{ id: "a b" }] })],
    ["too many", entry({ refs: Array.from({ length: 65 }, (_, i) => ({ id: `r${i}` })) })],
    [
      "refs on a user entry",
      { entries: [{ id: "m1", turn: 1, role: "user", status: "complete", refs: [{ id: "a1" }] }] },
    ],
    [
      "refs on a restricted entry",
      entry({ status: "restricted", parts: undefined, refs: [{ id: "a1" }] }),
    ],
  ])("refuses %s", (_n, v) => expect(checkKindValue("Chat", v).ok).toBe(false));

  it("folds a wire refs field into the entry when the feed is told the source writes markers", () => {
    const feed = new ChatFeed({ refMarkers: true });
    feed.applyHistory(
      {
        entries: [
          {
            turn: 1,
            role: "assistant",
            status: "complete",
            text: "x [[a1]]",
            cursor: "1.1",
            refs: ["a1", "bad id", "a1"],
          },
        ],
        done: true,
      },
      "backward"
    );
    const v = feed.value();
    expect(v.refMarkers).toBe(true);
    expect(v.entries[0]?.refs).toEqual([{ id: "a1" }]);
    expect(new ChatFeed().value().refMarkers).toBeUndefined();
  });
});
