import { describe, expect, it } from "vitest";
import { ChatFeed, chatReasoningFromDurable } from "./chatFeed";
import { MAX_CHAT_REASONING_TEXT, chatValueIssues, isChatValue } from "./chatValue";
import { chatReasoningLine, chatTranscriptLines } from "./chatWords";

// Model reasoning in the transcript (loom ADR 0133 D6). Off unless the host asks; a separate channel
// from the reply text; model output derived from untrusted input, so cleaned like any reply text.

const wire = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  turn,
  role,
  text: `${role} ${turn}`,
  status: "complete",
  cursor: `0.${turn * 2 + (role === "user" ? 0 : 1)}`,
  ...over,
});
const replyText = (v: ReturnType<ChatFeed["value"]>, i: number): string =>
  v.entries[i]?.parts?.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";

describe("ChatFeed reasoning: off by default", () => {
  it("ignores reasoning events without a finding and never adds the field", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "user"));
    expect(f.applyEvent("reasoning", { turn: 1, text: "think" })).toEqual({
      ok: true,
      changed: false,
    });
    expect(f.applyEvent("reasoning-partial", { turn: 1, text: "think" }).ok).toBe(true);
    f.applyEvent("delta", { turn: 1, text: "Hi" });
    expect(f.streaming).toBe(true);
    expect(JSON.stringify(f.value())).not.toContain("think");
    expect(f.value().entries.every((e) => e.reasoning === undefined)).toBe(true);
    f.applyEvent("message", wire(1, "assistant"));
    expect(f.value().entries.every((e) => e.reasoning === undefined)).toBe(true);
  });

  it("a feed with reasoning off produces the very same value as before for the same events", () => {
    const run = (opts?: ConstructorParameters<typeof ChatFeed>[0]) => {
      const f = new ChatFeed(opts);
      f.applyHistory({ entries: [wire(1, "assistant"), wire(1, "user")], done: true }, "backward");
      f.applyEvent("message", wire(2, "user"));
      f.applyEvent("delta", { turn: 2, text: "Hel" });
      f.applyEvent("delta", { turn: 2, text: "lo" });
      return f.value();
    };
    expect(run({ reasoning: false })).toEqual(run());
    // ...and turning it on changes nothing for a transcript that never receives reasoning.
    expect(run({ reasoning: true })).toEqual(run());
    expect(run({ reasoning: { durable: false } })).toEqual(run());
  });
});

describe("ChatFeed reasoning: live", () => {
  const on = () => {
    const f = new ChatFeed({ reasoning: true });
    f.applyEvent("message", wire(1, "user"));
    return f;
  };

  it("builds the in-progress reply's reasoning on its own channel; reply text never contains it", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "Let me " });
    // Reasoning before any reply text still makes the streaming reply.
    expect(f.streaming).toBe(true);
    let e = f.value().entries.at(-1);
    expect(e).toMatchObject({
      id: "t1.assistant",
      status: "streaming",
      reasoning: { text: "Let me ", kind: "summary", streaming: true },
    });
    expect(e?.parts).toBeUndefined();
    f.applyEvent("reasoning", { turn: 1, text: "think." });
    f.applyEvent("delta", { turn: 1, text: "Answer" });
    e = f.value().entries.at(-1);
    expect(e?.reasoning?.text).toBe("Let me think.");
    expect(replyText(f.value(), 1)).toBe("Answer");
    expect(isChatValue(f.value())).toBe(true);
  });

  it("a text delta never lands in reasoning and a reasoning delta never lands in text", () => {
    const f = on();
    f.applyEvent("delta", { turn: 1, text: "TEXT" });
    f.applyEvent("reasoning", { turn: 1, text: "THOUGHT" });
    const e = f.value().entries.at(-1);
    expect(e?.parts).toEqual([{ type: "text", text: "TEXT" }]);
    expect(e?.reasoning?.text).toBe("THOUGHT");
  });

  it("liveKind labels the live text (default summary, never upgraded on its own)", () => {
    const f = new ChatFeed({ reasoning: { liveKind: "text" } });
    f.applyEvent("message", wire(1, "user"));
    f.applyEvent("reasoning", { turn: 1, text: "x" });
    expect(f.value().entries.at(-1)?.reasoning?.kind).toBe("text");
  });

  it("reasoning-partial REPLACES: a reconnect mid-call leaves no duplicated text", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "ab" });
    f.applyEvent("reasoning", { turn: 1, text: "cd" });
    // The stream drops and reopens: the server catches us up with everything so far.
    f.applyEvent("partial", { turn: 1, text: "Ans" });
    f.applyEvent("reasoning-partial", { turn: 1, text: "abcd" });
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("abcd");
    f.applyEvent("reasoning", { turn: 1, text: "ef" });
    f.applyEvent("reasoning-partial", { turn: 1, text: "abcdef" });
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("abcdef");
    expect(replyText(f.value(), 1)).toBe("Ans");
  });

  it("reset clears the reasoning (and only for the turn it names)", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "old" });
    expect(f.applyEvent("reset", { turn: 2 })).toEqual({ ok: true, changed: false });
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("old");
    expect(f.applyEvent("reset", { turn: 1 })).toEqual({ ok: true, changed: true });
    expect(f.streaming).toBe(false);
    expect(f.value().entries.every((e) => e.reasoning === undefined)).toBe(true);
    f.applyEvent("reasoning", { turn: 1, text: "new" });
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("new");
  });

  it("a closed conversation drops live reasoning", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "x" });
    f.applyEvent("closed", {});
    expect(f.streaming).toBe(false);
  });

  it("the durable reply keeps the live reasoning as its own (same slot, no longer streaming)", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "because" });
    f.applyEvent("delta", { turn: 1, text: "Hi" });
    f.applyEvent("message", wire(1, "assistant", { text: "Hi there" }));
    const e = f.value().entries.at(-1);
    expect(e).toMatchObject({
      id: "t1.assistant",
      status: "complete",
      reasoning: { text: "because", streaming: false },
    });
    expect(replyText(f.value(), 1)).toBe("Hi there");
    // Reasoning arriving after the durable reply is dropped (the log won).
    expect(f.applyEvent("reasoning", { turn: 1, text: " late" }).ok).toBe(true);
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("because");
    expect(isChatValue(f.value())).toBe(true);
  });

  it("a restricted reply keeps no reasoning", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "secret" });
    f.applyEvent("message", wire(1, "assistant", { status: "restricted", text: "" }));
    expect(JSON.stringify(f.value())).not.toContain("secret");
    expect(isChatValue(f.value())).toBe(true);
  });

  it("shared mode, viewer is the owner, another participant asks: the live reasoning renders", () => {
    const f = new ChatFeed({ reasoning: true, viewer: { actor: "alice" }, mode: "shared" });
    f.applyEvent("message", wire(1, "user", { asker: { actor: "bob" } }));
    f.applyEvent("reasoning", { turn: 1, text: "bob's thought" });
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("bob's thought");
    f.applyEvent("reasoning-partial", { turn: 1, text: "bob's whole thought" });
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("bob's whole thought");
  });

  it("a non-audience viewer who receives no events sees no reasoning", () => {
    const f = new ChatFeed({ reasoning: true, viewer: { actor: "carol" }, mode: "shared" });
    f.applyEvent("message", wire(1, "user", { asker: { actor: "bob" } }));
    expect(f.streaming).toBe(false);
    expect(f.value().entries.every((e) => e.reasoning === undefined)).toBe(true);
  });

  it("reasoning of a restricted turn is still not rendered in shared mode", () => {
    const f = new ChatFeed({ reasoning: true, viewer: { actor: "alice" }, mode: "shared" });
    f.applyEvent(
      "message",
      wire(1, "user", { status: "restricted", text: "", asker: { actor: "bob" } })
    );
    f.applyEvent("reasoning", { turn: 1, text: "secret" });
    expect(JSON.stringify(f.value())).not.toContain("secret");
  });

  it("is untrusted: controls and bidi marks are removed, markup stays literal text", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "a\u001b[31mb‮c<img src=x onerror=alert(1)>" });
    expect(f.value().entries.at(-1)?.reasoning?.text).toBe("a[31mbc<img src=x onerror=alert(1)>");
  });

  it("is bounded: past the cap the text stops growing and is flagged truncated", () => {
    const f = on();
    for (let i = 0; i < 12; i++) f.applyEvent("reasoning", { turn: 1, text: "x".repeat(8192) });
    const r = f.value().entries.at(-1)?.reasoning;
    expect(r?.text.length).toBe(MAX_CHAT_REASONING_TEXT);
    expect(r?.truncated).toBe(true);
    expect(isChatValue(f.value())).toBe(true);
  });

  it("malformed reasoning events are refused with fixed text and change nothing", () => {
    const f = on();
    for (const bad of [null, "x", { turn: "1", text: "a" }, { turn: 1 }, { turn: 0, text: "a" }]) {
      const r = f.applyEvent("reasoning", bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.finding.code).toBe("reasoning-invalid");
    }
    expect(f.streaming).toBe(false);
  });

  it("a newer turn supersedes the older turn's live reasoning", () => {
    const f = on();
    f.applyEvent("reasoning", { turn: 1, text: "one" });
    f.applyEvent("message", wire(2, "user"));
    f.applyEvent("reasoning", { turn: 2, text: "two" });
    expect(f.applyEvent("reasoning", { turn: 1, text: "stale" })).toEqual({
      ok: true,
      changed: false,
    });
    const v = f.value().entries.filter((e) => e.reasoning !== undefined);
    expect(v.map((e) => e.reasoning?.text)).toEqual(["two"]);
  });
});

describe("chatReasoningFromDurable", () => {
  const body = (parts: unknown[], over: Record<string, unknown> = {}) => ({
    steps: [
      { stepId: "s1", recordedAttempt: 1, attempts: [{ attempt: 1, recorded: true, parts }] },
    ],
    ...over,
  });

  it("joins the recorded attempts' text; a summary anywhere makes the whole a summary", () => {
    expect(
      chatReasoningFromDurable(
        body([
          { kind: "text", status: "ok", text: "a" },
          { kind: "text", status: "ok", text: "b" },
        ])
      )
    ).toEqual({ text: "a\n\nb", kind: "text", streaming: false });
    expect(
      chatReasoningFromDurable(
        body([
          { kind: "text", status: "ok", text: "a" },
          { kind: "summary", status: "ok", text: "b" },
        ])
      )?.kind
    ).toBe("summary");
  });

  it("ignores a superseded attempt", () => {
    const b = {
      steps: [
        {
          stepId: "s",
          recordedAttempt: 2,
          attempts: [
            { attempt: 1, recorded: false, parts: [{ kind: "text", status: "ok", text: "OLD" }] },
            { attempt: 2, recorded: true, parts: [{ kind: "text", status: "ok", text: "NEW" }] },
          ],
        },
      ],
    };
    expect(chatReasoningFromDurable(b)?.text).toBe("NEW");
  });

  it("redacted and omitted-display parts carry no text", () => {
    expect(chatReasoningFromDurable(body([{ kind: "redacted", status: "ok" }]))).toEqual({
      text: "",
      kind: "redacted",
      streaming: false,
    });
    expect(
      chatReasoningFromDurable(body([{ kind: "summary", status: "ok", text: "" }]))?.kind
    ).toBe("redacted");
  });

  it("erased and digest-mismatch parts never contribute text", () => {
    expect(chatReasoningFromDurable(body([{ kind: "text", status: "erased" }]))).toMatchObject({
      status: "erased",
      text: "",
    });
    expect(
      chatReasoningFromDurable(
        body([{ kind: "text", status: "digest-mismatch", text: "TAMPERED" }])
      )
    ).toMatchObject({ status: "digest-mismatch", text: "" });
    // an unknown status fails closed as unverifiable
    expect(
      chatReasoningFromDurable(body([{ kind: "text", status: "weird", text: "X" }]))
    ).toMatchObject({ status: "digest-mismatch", text: "" });
    // ok text wins over an erased sibling
    expect(
      chatReasoningFromDurable(
        body([
          { kind: "text", status: "erased" },
          { kind: "text", status: "ok", text: "kept" },
        ])
      )?.text
    ).toBe("kept");
  });

  it("carries the server's truncated flag, bounds its own output, and is total", () => {
    expect(
      chatReasoningFromDurable(
        body([{ kind: "text", status: "ok", text: "a" }], { truncated: true })
      )?.truncated
    ).toBe(true);
    const big = chatReasoningFromDurable(
      body([{ kind: "text", status: "ok", text: "y".repeat(MAX_CHAT_REASONING_TEXT * 3) }])
    );
    expect((big?.text.length ?? 0) <= MAX_CHAT_REASONING_TEXT).toBe(true);
    expect(big?.truncated).toBe(true);
    for (const junk of [
      undefined,
      null,
      1,
      "x",
      [],
      {},
      { steps: "no" },
      { steps: [null, 1, { attempts: 3 }] },
    ])
      expect(chatReasoningFromDurable(junk)).toBeUndefined();
  });

  it("cleans the text like any reply text", () => {
    expect(
      chatReasoningFromDurable(body([{ kind: "text", status: "ok", text: "a‮b\u001bc" }]))?.text
    ).toBe("abc");
  });
});

describe("ChatFeed reasoning: durable, lazily", () => {
  const history = () => new ChatFeed({ reasoning: { durable: true }, mode: "owner" });
  const load = (f: ChatFeed) =>
    f.applyHistory({ entries: [wire(1, "assistant"), wire(1, "user")], done: true }, "backward");
  const body = (text: string) => ({
    steps: [
      {
        stepId: "s",
        attempts: [
          { attempt: 1, recorded: true, parts: [{ kind: "summary", status: "ok", text }] },
        ],
      },
    ],
  });

  it("offers an unloaded marker for a finished reply, and nothing is fetched until asked", () => {
    const f = history();
    load(f);
    const a = f.value().entries.find((e) => e.role === "assistant");
    expect(a?.reasoning).toEqual({ text: "", kind: "text", streaming: false, status: "unloaded" });
    expect(isChatValue(f.value())).toBe(true);
    expect(f.value().entries.find((e) => e.role === "user")?.reasoning).toBeUndefined();
  });

  it("begin -> loading, apply -> the stored reasoning; begun at most once", () => {
    const f = history();
    load(f);
    expect(f.beginReasoning("0.3")).toEqual({ ok: true, changed: true });
    expect(f.value().entries.find((e) => e.role === "assistant")?.reasoning?.status).toBe(
      "loading"
    );
    expect(
      f.beginReasoning("0.3").ok && (f.beginReasoning("0.3") as { changed: boolean }).changed
    ).toBe(false);
    expect(f.applyReasoning("0.3", body("why")).ok).toBe(true);
    expect(f.value().entries.find((e) => e.role === "assistant")?.reasoning).toEqual({
      text: "why",
      kind: "summary",
      streaming: false,
    });
    expect(f.beginReasoning("0.3")).toEqual({ ok: true, changed: false });
  });

  it("nothing usable is unavailable; a transit failure goes back to unloaded (retryable)", () => {
    const f = history();
    load(f);
    f.beginReasoning("0.3");
    f.applyReasoning("0.3", { steps: [] });
    expect(f.value().entries.find((e) => e.role === "assistant")?.reasoning?.status).toBe(
      "unavailable"
    );
    const g = history();
    load(g);
    g.beginReasoning("0.3");
    g.reasoningFailed("0.3");
    expect(g.value().entries.find((e) => e.role === "assistant")?.reasoning?.status).toBe(
      "unloaded"
    );
    expect(g.beginReasoning("0.3")).toEqual({ ok: true, changed: true });
  });

  it("an apply with no begin, an unknown cursor, a user entry and a malformed cursor do nothing", () => {
    const f = history();
    load(f);
    expect(f.applyReasoning("0.3", body("x"))).toEqual({ ok: true, changed: false });
    for (const c of ["9.9", "0.2", "../x"])
      expect(f.beginReasoning(c)).toEqual({ ok: true, changed: false });
  });

  it("is off without durable (and without reasoning at all)", () => {
    for (const opts of [{ reasoning: true }, {}] as const) {
      const f = new ChatFeed(opts);
      load(f);
      expect(f.value().entries.every((e) => e.reasoning === undefined)).toBe(true);
      expect(f.beginReasoning("0.3")).toEqual({ ok: true, changed: false });
    }
  });

  it("shared mode offers it on every finished reply; a 404 becomes unavailable (no retry)", () => {
    const f = new ChatFeed({
      reasoning: { durable: true },
      mode: "shared",
      viewer: { actor: "alice" },
    });
    f.applyHistory(
      {
        entries: [
          wire(2, "assistant"),
          wire(2, "user", { asker: { actor: "bob" } }),
          wire(1, "assistant"),
          wire(1, "user", { asker: { actor: "alice" } }),
        ],
        done: true,
      },
      "backward"
    );
    const by = (turn: number) =>
      f.value().entries.find((e) => e.turn === turn && e.role === "assistant");
    expect(by(1)?.reasoning?.status).toBe("unloaded");
    expect(by(2)?.reasoning?.status).toBe("unloaded");
    expect(f.beginReasoning("0.5")).toEqual({ ok: true, changed: true });
    expect(by(2)?.reasoning?.status).toBe("loading");
    expect(f.reasoningUnavailable("0.5").ok).toBe(true);
    expect(by(2)?.reasoning?.status).toBe("unavailable");
    expect(f.beginReasoning("0.5")).toEqual({ ok: true, changed: false });
  });

  it("a fetched record survives the placeholder-free path: loaded reasoning is kept across value() calls", () => {
    const f = history();
    load(f);
    f.beginReasoning("0.3");
    f.applyReasoning("0.3", body("kept"));
    f.applyEvent("message", wire(2, "user"));
    expect(f.value().entries.find((e) => e.id === "t1.assistant")?.reasoning?.text).toBe("kept");
  });
});

describe("the ChatValue contract for reasoning", () => {
  const val = (reasoning: unknown, over: Record<string, unknown> = {}) => ({
    entries: [
      { id: "t1.assistant", turn: 1, role: "assistant", status: "complete", reasoning, ...over },
    ],
  });
  it("accepts every well-formed shape", () => {
    for (const r of [
      { text: "t", kind: "text", streaming: false },
      { text: "t", kind: "summary", streaming: true, truncated: true },
      { text: "", kind: "redacted", streaming: false },
      { text: "", kind: "text", streaming: false, status: "erased" },
      { text: "", kind: "text", streaming: false, status: "digest-mismatch" },
      { text: "", kind: "text", streaming: false, status: "unloaded" },
      { text: "", kind: "text", streaming: false, status: "loading" },
      { text: "", kind: "text", streaming: false, status: "unavailable" },
    ])
      expect(chatValueIssues(val(r))).toEqual([]);
  });
  it("refuses a bad shape, text on redacted / removed reasoning, a stray key, a user entry and a restricted entry", () => {
    for (const r of [
      "x",
      { text: 1, kind: "text", streaming: false },
      { text: "t", kind: "weird", streaming: false },
      { text: "t", kind: "text" },
      { text: "t", kind: "text", streaming: false, status: "nope" },
      { text: "leak", kind: "redacted", streaming: false },
      { text: "leak", kind: "text", streaming: false, status: "erased" },
      { text: "t", kind: "text", streaming: false, html: "<b>" },
      { text: "x".repeat(MAX_CHAT_REASONING_TEXT + 1), kind: "text", streaming: false },
    ])
      expect(chatValueIssues(val(r)).length).toBeGreaterThan(0);
    const ok = { text: "t", kind: "text", streaming: false };
    expect(chatValueIssues(val(ok, { role: "user", id: "m0" })).length).toBeGreaterThan(0);
    expect(chatValueIssues(val(ok, { status: "restricted" })).length).toBeGreaterThan(0);
  });
});

describe("reasoning in transcript lines (the terminal)", () => {
  const entry = (reasoning: unknown) =>
    ({
      entries: [
        {
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "complete",
          parts: [{ type: "text", text: "Hi" }],
          reasoning,
        },
      ],
    }) as never;
  it("prints reasoning as a labelled line before the reply; summary labelled; markers carry no text", () => {
    expect(chatTranscriptLines(entry({ text: "a\nb", kind: "text", streaming: false }))).toEqual([
      "Assistant: [reasoning: a b] Hi",
    ]);
    expect(chatTranscriptLines(entry({ text: "s", kind: "summary", streaming: false }))).toEqual([
      "Assistant: [reasoning summary: s] Hi",
    ]);
    expect(chatTranscriptLines(entry({ text: "", kind: "redacted", streaming: false }))).toEqual([
      "Assistant: [reasoning redacted] Hi",
    ]);
    expect(
      chatTranscriptLines(entry({ text: "", kind: "text", streaming: false, status: "erased" }))
    ).toEqual(["Assistant: [reasoning removed] Hi"]);
    for (const status of ["unloaded", "loading", "unavailable", "digest-mismatch"])
      expect(
        chatTranscriptLines(entry({ text: "", kind: "text", streaming: false, status }))
      ).toEqual(["Assistant: Hi"]);
  });
  it("a reply without reasoning prints exactly as before", () => {
    expect(chatTranscriptLines(entry(undefined))).toEqual(["Assistant: Hi"]);
    expect(chatReasoningLine((entry(undefined) as { entries: never[] }).entries[0] as never)).toBe(
      ""
    );
  });
  it("cleans the text", () => {
    expect(
      chatTranscriptLines(entry({ text: "x\u001b[2Jy", kind: "text", streaming: false }))[0]
    ).not.toContain("\u001b");
  });
});
