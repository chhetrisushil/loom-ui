import { describe, expect, it } from "vitest";
import type { ChatValue } from "./chatValue";
import { chatTranscriptLines } from "./chatWords";

const md = (text: string, over: Record<string, unknown> = {}) => ({
  id: "t1.assistant",
  turn: 1,
  role: "assistant",
  status: "complete",
  parts: [{ type: "text", text, format: "markdown" }],
  ...over,
});
const user = (text: string) => ({
  id: "m1",
  turn: 1,
  role: "user",
  status: "complete",
  parts: [{ type: "text", text }],
});
const lines = (value: Record<string, unknown>) =>
  chatTranscriptLines({ ...value } as unknown as ChatValue);

describe("chatTranscriptLines, markdown replies", () => {
  it("prints a markdown reply as readable lines under the speaker, and a plain turn exactly as before", () => {
    expect(
      lines({
        entries: [
          user("a **b**"),
          md("# Terms\n\nDue in **30 days**, see [docs](https://example.com/a).\n\n- one\n- two"),
        ],
      })
    ).toEqual([
      "User: a **b**",
      "Assistant: # Terms",
      "",
      "  Due in **30 days**, see docs (https://example.com/a).",
      "",
      "  - one",
      "  - two",
    ]);
  });
  it("numbers listed reference markers, drops the others, and hides all of them while streaming", () => {
    const entries = (status: string) => [
      md("Due [[a1]] and [[zz]].", { status, refs: [{ id: "a1" }] }),
    ];
    expect(lines({ refMarkers: true, entries: entries("complete") })).toEqual([
      "Assistant: Due [1] and.",
    ]);
    expect(lines({ refMarkers: true, entries: entries("streaming") })[0]).toBe(
      "Assistant (replying): Due and."
    );
    expect(lines({ entries: entries("complete") })).toEqual(["Assistant: Due [[a1]] and [[zz]]."]);
  });
  it("is never markdown for a person's turn, whatever a source claims, and a part without a format stays plain", () => {
    const u = {
      ...user("**x** [a](https://e.example)"),
      parts: [{ type: "text", text: "**x** [a](https://e.example)", format: "markdown" }],
    };
    expect(lines({ entries: [u] })).toEqual(["User: **x** [a](https://e.example)"]);
    expect(
      lines({
        entries: [
          md("**x** [a](https://e.example)", {
            parts: [{ type: "text", text: "**x** [a](https://e.example)" }],
          }),
        ],
      })
    ).toEqual(["Assistant: **x** [a](https://e.example)"]);
  });
  it("keeps the failure sentence and tool line after a markdown body, and never emits a control character", () => {
    const out = lines({
      entries: [md("ok\u001b[2J", { tools: [{ name: "search", status: "done" }] })],
    }).join("\n");
    expect(out).toContain("Assistant: ok");
    expect(out).toContain("search done");
    expect([...out].some((ch) => ch.charCodeAt(0) < 32 && ch !== "\n")).toBe(false);
  });
  it("a markdown reply is capped in total characters, comparable to a plain part's maxText", () => {
    const out = lines({ entries: [md("word ".repeat(4000))] });
    expect(out.join("").length).toBeLessThanOrEqual(4 * 2000 + 40);
    expect(out.join("\n")).toContain("…");
    const small = chatTranscriptLines(
      { entries: [md("word ".repeat(4000))] } as unknown as ChatValue,
      { maxText: 100 }
    );
    expect(small.join("").length).toBeLessThanOrEqual(4 * 100 + 40);
  });
  it("strips C1 (incl. U+009B), bidi overrides and isolates and ZWSP on the transcript path", () => {
    const out = lines({
      entries: [
        md("a\u009b31m b\u202ec \u2066d\u2069 e\u200bf [l\u009b](https://e.example/\u202e)"),
      ],
    }).join("\n");
    expect(out).not.toMatch(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069\u200b]/);
    expect(out).toContain("a31m bc d ef");
  });
  it("puts a second markdown part on its own line, not mid-line after a plain one", () => {
    const e = {
      ...md("# h"),
      parts: [
        { type: "text", text: "plain" },
        { type: "text", text: "# h", format: "markdown" },
      ],
    };
    expect(lines({ entries: [e] }).join("\n")).not.toContain("plain # h");
  });
});
