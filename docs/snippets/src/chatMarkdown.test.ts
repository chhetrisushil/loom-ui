import {
  ChatFeed,
  chatMarkdownLines,
  checkKindValue,
  parseChatMarkdown,
  resolveMdMarkers,
} from "@loom-ui/core";
import { describe, expect, it } from "vitest";

// The reference example for markdown in a chat transcript: a support assistant that answers in markdown and cites
// ticket numbers. It is not any one product's app: any transcript source that says `markdown: true` gets the same.

const TICKET = "TCK-1042";
const answer = [
  `Your refund was **approved** [[${TICKET}]].`,
  "",
  "| step | owner |",
  "|---|---|",
  "| approve | billing |",
  "| pay out | finance |",
  "",
  "Read the [refund policy](https://example.com/policy), or run `refund --status`.",
].join("\n");

describe("markdown in a chat transcript", () => {
  it("the feed marks the assistant's text, and the value passes the Chat contract", () => {
    const feed = new ChatFeed({ markdown: true, refMarkers: true });
    feed.applyHistory(
      {
        entries: [
          {
            turn: 1,
            role: "assistant",
            text: answer,
            status: "complete",
            cursor: "1.2",
            refs: [TICKET],
          },
          {
            turn: 1,
            role: "user",
            text: "Is my **refund** done?",
            status: "complete",
            cursor: "1.1",
          },
        ],
        done: true,
      },
      "backward"
    );
    const value = feed.value();
    expect(checkKindValue("Chat", value).ok).toBe(true);
    const [user, reply] = value.entries;
    expect(user?.parts).toEqual([{ type: "text", text: "Is my **refund** done?" }]);
    expect(reply?.parts?.[0]).toMatchObject({ type: "text", format: "markdown" });
  });

  it("the text is parsed into a closed tree: structure, a safe link, a numbered marker", () => {
    const doc = resolveMdMarkers(parseChatMarkdown(answer, { markers: true }), new Set([TICKET]), {
      hideAll: false,
    });
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "table", "paragraph"]);
    expect(JSON.stringify(doc)).toContain('"type":"ref"');
    expect(JSON.stringify(doc)).toContain("https://example.com/policy");
  });

  it("a renderer without a DOM reads the same tree as plain lines", () => {
    const lines = chatMarkdownLines(
      resolveMdMarkers(parseChatMarkdown(answer, { markers: true }), new Set([TICKET]), {
        hideAll: false,
      })
    );
    expect(lines[0]).toBe("Your refund was **approved** [1].");
    expect(lines).toContain("| approve | billing |");
    expect(lines.at(-1)).toBe(
      "Read the refund policy (https://example.com/policy), or run `refund --status`."
    );
  });
});
