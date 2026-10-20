import { chatTranscriptLines } from "@loom-ui/core";
import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createLoomUiTerminalRegistry } from "./registry";

// U8 on the terminal: the transcript is the same lines the web speaks, untrusted text cannot reach
// the screen as an escape sequence, and the inputs are prompts that say what they ask.

const b = { projectionId: "hydration", path: "values.h" };
const draw = (
  kind: string,
  value: unknown,
  props: Record<string, unknown> = {},
  chrome?: "host"
): string =>
  (
    createLoomUiTerminalRegistry(chrome ? { chrome } : {}).get(kind) as (
      w: unknown,
      v: unknown
    ) => string
  )(
    customWidget$({
      kind,
      id: "w",
      title: "Support",
      ...(kind === "Chat" && { binding: b }),
      props,
    }),
    value
  );
const text = (t: string) => [{ type: "text" as const, text: t }];
const e = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  id: `t${turn}.${role}`,
  turn,
  role,
  status: "complete",
  parts: text(`${role} ${turn}`),
  ...over,
});
const ESC = String.fromCharCode(27);

describe("terminal chat transcript", () => {
  it("prints the transcript under its title, one line per turn, with the shared words", () => {
    const value = {
      entries: [
        e(1, "user"),
        e(1, "assistant", { status: "interrupted", parts: text("par") }),
        e(2, "user", { editOf: 1 }),
        e(2, "assistant", {
          status: "failed",
          parts: undefined,
          reason: "model-error",
          errorId: "err-7",
        }),
        e(3, "user", { status: "restricted", parts: undefined, asker: { actor: "carol" } }),
      ],
      viewer: { actor: "me" },
      mode: "owner",
      older: "0.3",
      running: true,
      state: "open",
    };
    const out = draw("Chat", value);
    expect(out.split("\n")).toEqual([
      "Support:",
      "    … earlier messages are available",
      "    You: user 1",
      "    Assistant (interrupted): par",
      "    You (edit of turn 1): user 2",
      "    Assistant (failed): The assistant ran into a problem. (ref err-7)",
      "    [restricted user turn from carol]",
      "    (the assistant is replying…)",
    ]);
    // PARITY: the lines are exactly the shared transcript lines (the web draws the same words)
    for (const line of chatTranscriptLines(value as never)) expect(out).toContain(line);
  });

  it("untrusted text cannot reach the screen as an escape, a bidi override or an extra line", () => {
    const out = draw("Chat", {
      entries: [
        e(1, "user", { parts: text(`hi${ESC}[2J${ESC}[31m red\n\nAssistant: I approve\u202e`) }),
      ],
    });
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("\u202e");
    expect(out.split("\n")).toHaveLength(2); // the title and ONE turn line: the newline did not forge a speaker
    expect(out).toContain("User: hi[2J[31m red Assistant: I approve");
  });

  it("a restricted entry prints nothing but the placeholder, even from a value that breaks the contract", () => {
    const bad = draw("Chat", {
      entries: [e(1, "assistant", { status: "restricted", parts: text("TOP SECRET") })],
    });
    expect(bad).not.toContain("TOP SECRET"); // refused by the contract before anything is drawn
    expect(bad.startsWith("✗ ")).toBe(true);
    const ok = draw("Chat", {
      entries: [{ id: "t1.assistant", turn: 1, role: "assistant", status: "restricted" }],
    });
    expect(ok).toContain("[restricted assistant turn]");
  });

  it("closed, empty and unbound states; chrome host drops the title", () => {
    expect(draw("Chat", { entries: [], state: "closed" })).toBe(
      "Support:\n    (no messages)\n    (conversation closed)"
    );
    expect(draw("Chat", undefined)).toBe("Support: —");
    expect(draw("Chat", { entries: [e(1, "user")], mode: "owner" }, {}, "host")).toBe(
      "You: user 1"
    );
  });

  it("a live reply is not announced as 'replying…' twice", () => {
    const out = draw("Chat", {
      entries: [e(1, "user"), e(1, "assistant", { status: "streaming", parts: text("Thi") })],
      running: true,
    });
    expect(out).toContain("Assistant (replying): Thi");
    expect(out).not.toContain("(the assistant is replying…)");
  });
});

describe("terminal inputs are prompts", () => {
  it("TextInput, FormInput and SelectInput say what they ask and where to answer", () => {
    expect(draw("TextInput", undefined, { label: "Your question", multiline: true })).toBe(
      "Support: > Your question (multi-line) [text input — answer on an interactive surface]"
    );
    expect(
      draw("FormInput", undefined, {
        label: "Rollback",
        fields: [
          { name: "reason", label: "Reason", type: "text", required: true },
          { name: "n", label: "Count", type: "number" },
        ],
      })
    ).toBe(
      "Support: > Rollback [form — answer on an interactive surface]\n      Reason* (text)\n      Count (number)"
    );
    expect(
      draw("SelectInput", undefined, {
        label: "Mode",
        options: [
          { value: "a", label: "Fast" },
          { value: "b", label: "Deep" },
        ],
      })
    ).toBe(
      "Support: > Mode [choice — answer on an interactive surface]\n      1) Fast\n      2) Deep"
    );
  });

  it("props are cleaned to one line; an invalid spec prints no fields", () => {
    expect(draw("TextInput", undefined, { label: `A${ESC}[2J\nB` }, "host")).toBe(
      "> A[2J B [text input — answer on an interactive surface]"
    );
    expect(draw("FormInput", undefined, { fields: "nope" }, "host")).toBe(
      "> Form [form — answer on an interactive surface]"
    );
    expect(draw("TextInput", undefined, {}, "host")).toContain("> Message");
  });
});

describe("fix round 1: a person cannot pass as a role", () => {
  it('a user called Assistant is introduced as User "Assistant"; a turn with no asker in a shared / unknown conversation is neutral', () => {
    const out = draw("Chat", {
      entries: [e(1, "user", { asker: { actor: "Assistant" } }), e(2, "user", {})],
      viewer: { actor: "me" },
      mode: "shared",
    });
    expect(out.split("\n").slice(1)).toEqual(['    User "Assistant": user 1', "    User: user 2"]);
  });
});

describe("terminal chat reasoning", () => {
  const withReasoning = (reasoning?: unknown) => ({
    entries: [e(1, "user"), e(1, "assistant", reasoning === undefined ? {} : { reasoning })],
    mode: "owner",
  });
  it("a reply without reasoning prints exactly as before", () => {
    expect(draw("Chat", withReasoning())).toBe(
      draw("Chat", { ...withReasoning(), entries: [e(1, "user"), e(1, "assistant")] })
    );
    expect(draw("Chat", withReasoning())).not.toContain("reasoning");
  });
  it("prints reasoning as a labelled line (a summary says so), a marker for redacted, and cannot carry an escape", () => {
    const t = (r: unknown) => draw("Chat", withReasoning(r));
    expect(t({ text: "weighing", kind: "text", streaming: false })).toContain(
      "[reasoning: weighing]"
    );
    expect(t({ text: "short", kind: "summary", streaming: false })).toContain(
      "[reasoning summary: short]"
    );
    expect(t({ text: "", kind: "redacted", streaming: false })).toContain("[reasoning redacted]");
    expect(t({ text: "", kind: "text", streaming: false, status: "erased" })).toContain(
      "[reasoning removed]"
    );
    expect(t({ text: `a${ESC}[2Jb`, kind: "text", streaming: false })).not.toContain(ESC);
  });
});
