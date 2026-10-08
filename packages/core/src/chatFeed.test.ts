import { describe, expect, it } from "vitest";
import { ChatFeed, chatEntryFromWire, compareChatCursors } from "./chatFeed";
import { MAX_CHAT_ENTRIES, isChatValue } from "./chatValue";
import { MAX_STREAM_TEXT } from "./streamText";

// A history entry exactly as @loom/conversation's `HistoryEntry` serialises it (ADR 0122 D3).
const wire = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  turn,
  role,
  text: `${role} ${turn}`,
  status: "complete",
  cursor: `0.${turn * 2 + (role === "user" ? 0 : 1)}`,
  executionId: "conv-1",
  at: 1000 + turn,
  ...over,
});
const page = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  entries,
  done: true,
  ...over,
});
const textOf = (
  v: { entries: readonly { parts?: readonly { type: string; text?: string }[] }[] },
  i: number
) => v.entries[i]?.parts?.map((p) => p.text).join("") ?? "";

describe("ChatFeed: history", () => {
  it("folds a backward page (newest first) into an oldest-first transcript and stays contract-valid", () => {
    const f = new ChatFeed();
    f.applyHistory(
      page([wire(2, "assistant"), wire(2, "user"), wire(1, "assistant"), wire(1, "user")]),
      "backward"
    );
    const v = f.value();
    expect(v.entries.map((e) => e.id)).toEqual(["u0.2", "t1.assistant", "u0.4", "t2.assistant"]);
    expect(textOf(v, 0)).toBe("user 1");
    expect(isChatValue(v)).toBe(true);
    expect(v.older).toBeUndefined(); // done: the start is in the window
  });

  it("offers the cursor that loads earlier turns, and a second page prepends without duplicating", () => {
    const f = new ChatFeed();
    f.applyHistory(
      page([wire(3, "user"), wire(2, "assistant")], { done: false, nextCursor: "0.3" }),
      "backward"
    );
    expect(f.value().older).toBe("0.3");
    expect(f.value().entries.map((e) => e.turn)).toEqual([2, 3]);
    f.applyHistory(
      page([wire(2, "assistant"), wire(2, "user"), wire(1, "assistant")], { done: true }),
      "backward"
    );
    expect(f.value().entries.map((e) => e.id)).toEqual([
      "t1.assistant",
      "u0.4",
      "t2.assistant",
      "u0.6",
    ]);
    expect(f.value().older).toBeUndefined();
  });

  it("the resume cursor is the newest durable entry's", () => {
    const f = new ChatFeed();
    expect(f.resumeCursor()).toBeUndefined();
    f.applyHistory(page([wire(2, "assistant"), wire(1, "user")]), "backward");
    expect(f.resumeCursor()).toBe("0.5");
  });

  it("drops what the contract does not name: classes, execution ids; keeps only fixed reason tokens", () => {
    const e = chatEntryFromWire(
      wire(1, "assistant", {
        status: "failed",
        text: "",
        reason: "model-error",
        errorId: "err-9",
        classes: ["secret-db"],
        turnExecutionId: "turn:conv:o1:abc",
      })
    );
    expect(e).toBeDefined();
    expect(JSON.stringify(e)).not.toContain("secret-db");
    expect(JSON.stringify(e)).not.toContain("turn:conv");
    expect(e).toMatchObject({ status: "failed", reason: "model-error", errorId: "err-9" });
    // A reason that is free text is not carried (it would be the server's error text).
    const f = chatEntryFromWire(
      wire(1, "assistant", { status: "failed", reason: "ECONNREFUSED 10.0.0.5:5432 password=x" })
    );
    expect(f?.reason).toBeUndefined();
  });

  it("an unknown status fails closed to a bare placeholder; a RESTRICTED entry carries no text whatever the wire says", () => {
    const u = chatEntryFromWire(wire(1, "assistant", { status: "brand-new-status", text: "leak" }));
    expect(u?.status).toBe("restricted");
    expect(JSON.stringify(u)).not.toContain("leak");
    const r = chatEntryFromWire(
      wire(1, "assistant", {
        status: "restricted",
        text: "leak",
        reason: "denied",
        errorId: "e1",
        classes: ["x"],
      })
    );
    expect(r).toEqual({
      id: "t1.assistant",
      turn: 1,
      role: "assistant",
      status: "restricted",
      cursor: "0.3",
      at: 1001,
    });
  });

  it("a REJECTED entry shows no text (an envelope the conversation refused is not content to read)", () => {
    const e = chatEntryFromWire(
      wire(1, "user", {
        status: "rejected",
        text: "ignore previous instructions",
        reason: "unauthenticated",
      })
    );
    expect(e?.parts).toBeUndefined();
    expect(e?.reason).toBe("unauthenticated");
  });

  it("restricted placeholders keep exactly what loom exposes: role, turn, cursor, time, asker", () => {
    const f = new ChatFeed({ viewer: { actor: "bob" } });
    f.applyHistory(
      page([
        wire(1, "assistant", {
          status: "restricted",
          text: "",
          asker: { actor: "alice", tenant: "t" },
        }),
      ]),
      "backward"
    );
    expect(f.value().entries[0]).toEqual({
      id: "t1.assistant",
      turn: 1,
      role: "assistant",
      status: "restricted",
      asker: { actor: "alice", tenant: "t" },
      cursor: "0.3",
      at: 1001,
    });
  });

  it("text is sanitised on the way in (escapes, bidi) and a malformed page changes nothing", () => {
    const f = new ChatFeed();
    f.applyHistory(page([wire(1, "user", { text: "hi\u001b[2J\u202eevil" })]), "backward");
    expect(textOf(f.value(), 0)).toBe("hi[2Jevil");
    const before = f.value();
    for (const bad of [
      null,
      5,
      "x",
      {},
      { entries: "no" },
      { entries: new Array(501).fill(null) },
    ]) {
      const r = f.applyHistory(bad, "backward");
      expect(r.ok).toBe(false);
    }
    expect(f.value()).toBe(before);
  });

  it("is bounded: the window holds at most maxEntries and says nothing is hidden beyond it", () => {
    const f = new ChatFeed({ maxEntries: 4 });
    const many = Array.from({ length: 10 }, (_, i) => wire(10 - i, "user"));
    f.applyHistory(page(many, { done: false, nextCursor: "0.1" }), "backward");
    expect(f.value().entries.length).toBe(3); // one slot of the 4 is held for the live reply
    expect(f.value().entries.at(-1)?.turn).toBe(10); // the newest are the ones kept
    expect(f.value().older).toBeUndefined(); // full window: no load-earlier that could not fit
    expect(new ChatFeed({ maxEntries: 10_000 }).value().entries.length).toBeLessThanOrEqual(
      MAX_CHAT_ENTRIES
    );
  });
});

describe("ChatFeed: the SSE stream", () => {
  it("a message is idempotent (a reconnect re-reads from the cursor) and immutable once visible", () => {
    const f = new ChatFeed();
    expect(f.applyEvent("message", wire(1, "user"))).toMatchObject({ ok: true, changed: true });
    expect(f.applyEvent("message", wire(1, "user"))).toMatchObject({ ok: true, changed: false });
    expect(f.value().entries).toHaveLength(1);
    // A DIFFERENT second copy of a visible entry is ignored, never applied (append-only).
    expect(f.applyEvent("message", wire(1, "user", { text: "rewritten history" }))).toMatchObject({
      changed: false,
    });
    expect(textOf(f.value(), 0)).toBe("user 1");
    // ...and an entry never goes visible -> restricted by a later event.
    expect(f.applyEvent("message", wire(1, "user", { status: "restricted" }))).toMatchObject({
      changed: false,
    });
    expect(f.value().entries[0]?.status).toBe("complete");
  });

  it("a placeholder may be upgraded to the real entry (the viewer gained clearance)", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "assistant", { status: "restricted" }));
    expect(f.value().entries[0]?.status).toBe("restricted");
    f.applyEvent("message", wire(1, "assistant"));
    expect(f.value().entries[0]?.status).toBe("complete");
  });

  it("streams a reply from deltas and the durable message replaces it IN PLACE (same id, never two)", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "user"));
    f.applyEvent("delta", { turn: 1, text: "Hel" });
    f.applyEvent("delta", { turn: 1, text: "lo" });
    let v = f.value();
    expect(v.entries.map((e) => [e.id, e.status])).toEqual([
      ["u0.2", "complete"],
      ["t1.assistant", "streaming"],
    ]);
    expect(textOf(v, 1)).toBe("Hello");
    expect(v.running).toBe(true);
    expect(f.streaming).toBe(true);
    expect(isChatValue(v)).toBe(true);
    f.applyEvent("message", wire(1, "assistant", { text: "Hello there" }));
    v = f.value();
    expect(v.entries.map((e) => [e.id, e.status])).toEqual([
      ["u0.2", "complete"],
      ["t1.assistant", "complete"],
    ]);
    expect(textOf(v, 1)).toBe("Hello there");
    expect(f.streaming).toBe(false);
    expect(v.running).toBe(false);
  });

  it("a delta for a turn that already has its durable reply is dropped (live text never touches history)", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "assistant", { text: "final" }));
    expect(f.applyEvent("delta", { turn: 1, text: "late" })).toMatchObject({ changed: false });
    expect(textOf(f.value(), 0)).toBe("final");
    expect(f.value().entries).toHaveLength(1);
  });

  it("deltas for a RESTRICTED question are not rendered", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "user", { status: "restricted" }));
    expect(f.applyEvent("delta", { turn: 1, text: "secret answer" })).toMatchObject({
      changed: false,
    });
    expect(f.applyEvent("partial", { turn: 1, text: "secret answer" })).toMatchObject({
      changed: false,
    });
    expect(JSON.stringify(f.value())).not.toContain("secret answer");
  });

  it("deltas for ANOTHER viewer's turn are not rendered; the viewer's own are", () => {
    const f = new ChatFeed({ viewer: { actor: "bob" } });
    f.applyEvent("message", wire(1, "user", { asker: { actor: "alice" } }));
    f.applyEvent("message", wire(2, "user", { asker: { actor: "bob" } }));
    expect(f.applyEvent("delta", { turn: 1, text: "for alice" })).toMatchObject({ changed: false });
    expect(f.applyEvent("delta", { turn: 2, text: "for bob" })).toMatchObject({ changed: true });
    const json = JSON.stringify(f.value());
    expect(json).not.toContain("for alice");
    expect(json).toContain("for bob");
    // a different tenant with the same actor name is a different identity
    const g = new ChatFeed({ viewer: { actor: "bob", tenant: "t1" } });
    g.applyEvent("message", wire(1, "user", { asker: { actor: "bob", tenant: "t2" } }));
    expect(g.applyEvent("delta", { turn: 1, text: "x" })).toMatchObject({ changed: false });
  });

  it("a partial catches a reconnecting client up; a reset discards it; an older turn's delta is stale", () => {
    const f = new ChatFeed();
    f.applyEvent("delta", { turn: 2, text: "abc" });
    f.applyEvent("partial", { turn: 2, text: "abcdef" });
    expect(textOf(f.value(), 0)).toBe("abcdef");
    expect(f.applyEvent("delta", { turn: 1, text: "old" })).toMatchObject({ changed: false });
    f.applyEvent("reset", { turn: 2 });
    expect(f.value().entries).toHaveLength(0);
    expect(f.streaming).toBe(false);
  });

  it("the live reply is bounded and a flood cannot grow it past the stream limit", () => {
    const f = new ChatFeed();
    for (let i = 0; i < 20; i++) f.applyEvent("delta", { turn: 1, text: "x".repeat(8000) });
    const t = textOf(f.value(), 0);
    expect(t.length).toBeLessThanOrEqual(MAX_STREAM_TEXT);
    expect(t.length).toBeGreaterThan(MAX_STREAM_TEXT - 8200);
    expect(isChatValue(f.value())).toBe(true);
  });

  it("an interrupted reply is a durable entry with the partial; the next turn follows", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "user"));
    f.applyEvent("delta", { turn: 1, text: "par" });
    f.applyEvent("message", wire(1, "assistant", { status: "interrupted", text: "partial" }));
    f.applyEvent("message", wire(2, "user"));
    expect(f.value().entries.map((e) => `${e.id}:${e.status}`)).toEqual([
      "u0.2:complete",
      "t1.assistant:interrupted",
      "u0.4:complete",
    ]);
    expect(f.value().running).toBe(true);
  });

  it("status and closed events set state; the server's error text is never read", () => {
    const f = new ChatFeed();
    f.applyEvent("status", { conversationId: "c", state: "open", running: true, turns: 3 });
    expect(f.value()).toMatchObject({ state: "open", running: true });
    f.applyEvent("delta", { turn: 4, text: "x" });
    f.applyEvent("closed", {});
    expect(f.value()).toMatchObject({ state: "closed", running: false });
    expect(f.streaming).toBe(false);
    const r = f.applyEvent("error", { error: "SELECT * FROM users; password=hunter2" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(f.applyEvent("reconnect", {})).toEqual({ ok: true, changed: false, reconnect: true });
    expect(f.applyEvent("surprise", {}).ok).toBe(false);
  });

  it("never throws on hostile event data", () => {
    const f = new ChatFeed();
    const cyc: Record<string, unknown> = {};
    cyc.cyc = cyc;
    for (const name of [
      "message",
      "status",
      "delta",
      "partial",
      "reset",
      "closed",
      "x",
      "__proto__",
    ])
      for (const data of [
        null,
        undefined,
        1,
        "s",
        [],
        cyc,
        { turn: "1" },
        { turn: -1, text: 1 },
        { turn: 1e99, text: "a" },
        JSON.parse('{"__proto__":{"turn":1},"turn":1,"text":"z"}'),
      ])
        expect(() => f.applyEvent(name, data)).not.toThrow();
    expect(isChatValue(f.value())).toBe(true);
  });
});

describe("ChatFeed: edit-previous-turn is a NEW turn, labelled by the host", () => {
  it("annotate labels a later turn; it never mutates the turn it points at or the log", () => {
    const f = new ChatFeed();
    f.applyHistory(
      page([
        wire(2, "user", { text: "revised question" }),
        wire(1, "assistant"),
        wire(1, "user", { text: "first question" }),
      ]),
      "backward"
    );
    expect(f.annotate(2, { editOf: 1 })).toMatchObject({ ok: true, changed: true });
    const v = f.value();
    expect(v.entries.find((e) => e.id === "u0.4")?.editOf).toBe(1);
    expect(v.entries.find((e) => e.id === "u0.2")).toMatchObject({ status: "complete" });
    expect(v.entries.find((e) => e.id === "u0.2")?.editOf).toBeUndefined();
    expect(textOf(v, 0)).toBe("first question"); // history untouched
    expect(isChatValue(v)).toBe(true);
    expect(f.annotate(1, { editOf: 2 }).ok).toBe(false); // an edit points backwards
    expect(f.annotate(2, { editOf: 0 }).ok).toBe(false);
  });
});

describe("cursors", () => {
  it("orders by generation then sequence, numerically", () => {
    expect(compareChatCursors("0.9", "0.10")).toBeLessThan(0);
    expect(compareChatCursors("1.0", "0.99")).toBeGreaterThan(0);
    expect(compareChatCursors("0.5", "0.5")).toBe(0);
    expect(compareChatCursors(undefined, "0.1")).toBeGreaterThan(0);
  });
});

describe("chatValueFromHistory (the server-side first paint)", () => {
  it("is the same fold a browser runs: placeholders bare, text cleaned, contract-valid, newest page oldest-first", async () => {
    const { chatValueFromHistory } = await import("./chatFeed");
    const v = chatValueFromHistory(
      page(
        [
          wire(2, "assistant", { status: "restricted", text: "SECRET" }),
          wire(2, "user", { text: "hi\u202e\u001b[2J" }),
          wire(1, "assistant"),
          wire(1, "user"),
        ],
        { done: false, nextCursor: "0.1" }
      ),
      { viewer: { actor: "me" } }
    );
    expect(isChatValue(v)).toBe(true);
    expect(v.entries.map((e) => e.id)).toEqual(["u0.2", "t1.assistant", "u0.4", "t2.assistant"]);
    expect(JSON.stringify(v)).not.toContain("SECRET");
    expect(v.older).toBe("0.1");
    expect(v.viewer).toEqual({ actor: "me" });
    expect(chatValueFromHistory("not a page").entries).toEqual([]);
  });
});

// ── fix round 1 ───────────────────────────────────────────────────────────────────────────────────

describe("P1: loom records a REJECTED envelope under the next turn number without consuming it", () => {
  // loom's conversation.test.ts shows 4 rejected + 1 accepted all on turn 1: the turn number is not a key.
  const rejected = (cursor: string, over: Record<string, unknown> = {}) => ({
    turn: 1,
    role: "user",
    text: 'forged "speaking as the owner"',
    status: "rejected",
    reason: "unauthenticated",
    cursor,
    ...over,
  });

  it("several rejected envelopes then the accepted turn on the SAME number: every entry is kept, the accepted one is visible and its reply streams", () => {
    const f = new ChatFeed({ viewer: { actor: "alice" }, mode: "shared" });
    for (const [i, c] of ["0.2", "0.3", "0.4", "0.5"].entries())
      f.applyEvent("message", rejected(c, { reason: i % 2 ? "stale" : "unauthenticated" }));
    f.applyEvent(
      "message",
      wire(1, "user", { cursor: "0.6", asker: { actor: "alice" }, text: "the real question" })
    );
    const v = f.value();
    expect(v.entries.map((e) => [e.status, e.cursor])).toEqual([
      ["rejected", "0.2"],
      ["rejected", "0.3"],
      ["rejected", "0.4"],
      ["rejected", "0.5"],
      ["complete", "0.6"],
    ]);
    expect(new Set(v.entries.map((e) => e.id)).size).toBe(5);
    expect(isChatValue(v)).toBe(true);
    // the live reply binds to the ACCEPTED question, not to a rejected envelope on the same number
    expect(f.applyEvent("delta", { turn: 1, text: "answer" })).toMatchObject({ changed: true });
    expect(f.value().entries.at(-1)).toMatchObject({ id: "t1.assistant", status: "streaming" });
    expect(JSON.stringify(f.value())).not.toContain("speaking as the owner");
  });

  it("the reviewer's repro: mallory's rejected turn 2 then alice's accepted turn 2 — alice's question is not hidden and her reply streams", () => {
    const f = new ChatFeed({ viewer: { actor: "alice" }, mode: "shared" });
    f.applyEvent("message", wire(1, "user", { cursor: "0.1", asker: { actor: "alice" } }));
    f.applyEvent("message", wire(1, "assistant", { cursor: "0.2" }));
    f.applyEvent(
      "message",
      rejected("0.3", { turn: 2, asker: { actor: "mallory" }, reason: "not-a-participant" })
    );
    f.applyEvent(
      "message",
      wire(2, "user", { cursor: "0.4", asker: { actor: "alice" }, text: "alice asks" })
    );
    const texts = f
      .value()
      .entries.map((e) => (e.parts?.[0] as { text?: string } | undefined)?.text ?? `(${e.status})`);
    expect(texts).toEqual(["user 1", "assistant 1", "(rejected)", "alice asks"]);
    expect(f.applyEvent("delta", { turn: 2, text: "for alice" })).toMatchObject({ changed: true });
    expect(JSON.stringify(f.value())).toContain("for alice");
  });

  it("a rejected envelope never makes a restricted / other-asker turn's live text visible, and never hides the accepted turn's", () => {
    const f = new ChatFeed({ viewer: { actor: "bob" }, mode: "shared" });
    f.applyEvent("message", wire(1, "user", { cursor: "0.1", asker: { actor: "alice" } })); // alice's turn
    f.applyEvent("message", rejected("0.2", { turn: 2, asker: { actor: "bob" } }));
    f.applyEvent("message", wire(2, "user", { cursor: "0.3", asker: { actor: "alice" } }));
    // turn 2's accepted question is alice's: bob must not see its live text, whatever the rejected entry says
    expect(f.applyEvent("delta", { turn: 2, text: "alice's answer" })).toMatchObject({
      changed: false,
    });
  });

  it("entries sort in LOG order and a source-provided record id (`ord`) is preferred as the key", () => {
    const f = new ChatFeed();
    f.applyHistory(
      page([wire(2, "user", { cursor: "0.9" }), wire(1, "user", { cursor: "0.2", ord: 7 })]),
      "backward"
    );
    expect(f.value().entries.map((e) => e.id)).toEqual(["m7", "u0.9"]);
    expect(f.applyEvent("message", wire(1, "user", { cursor: "0.2", ord: 7 }))).toMatchObject({
      changed: false,
    });
    // loom's edited TURN number (`editOfTurn`) is believed; one that does not point backwards is dropped,
    // and loom's `editOf` (the edited record's ord) is never read as a turn number (ADR 0122 R17b)
    const g = new ChatFeed();
    g.applyEvent("message", wire(3, "user", { cursor: "0.9", editOf: 7, editOfTurn: 1 }));
    g.applyEvent("message", wire(4, "user", { cursor: "0.10", editOfTurn: 9 }));
    expect(g.value().entries.map((e) => e.editOf)).toEqual([1, undefined]);
  });
});

describe("P2-2: a full window plus a live reply stays within the contract's 500", () => {
  it("250 durable turns (500 entries) + a streaming reply is a VALID value of at most 500 entries", () => {
    const f = new ChatFeed();
    for (let t = 1; t <= 250; t++) {
      f.applyEvent("message", wire(t, "user"));
      f.applyEvent("message", wire(t, "assistant"));
    }
    f.applyEvent("message", wire(251, "user"));
    f.applyEvent("delta", { turn: 251, text: "live" });
    const v = f.value();
    expect(v.entries.length).toBeLessThanOrEqual(MAX_CHAT_ENTRIES);
    expect(v.entries.at(-1)).toMatchObject({ status: "streaming", turn: 251 });
    expect(isChatValue(v)).toBe(true);
    expect(f.olderCursor()).toBeUndefined(); // full: no load-earlier that could not fit
  });
});

describe("P3: smaller guards", () => {
  it("live text shown before its question arrived is retracted when the question turns out restricted or another asker's", () => {
    const f = new ChatFeed({ viewer: { actor: "bob" }, mode: "shared" });
    f.applyEvent("delta", { turn: 1, text: "early live text" });
    expect(f.streaming).toBe(true);
    f.applyEvent("message", wire(1, "user", { status: "restricted", text: "" }));
    expect(f.streaming).toBe(false);
    expect(JSON.stringify(f.value())).not.toContain("early live text");
    const g = new ChatFeed({ viewer: { actor: "bob" }, mode: "shared" });
    g.applyEvent("delta", { turn: 1, text: "early" });
    g.applyEvent("message", wire(1, "user", { asker: { actor: "alice" } }));
    expect(g.streaming).toBe(false);
  });

  it("annotate never puts editOf on a restricted placeholder (the value stays valid) nor on a rejected envelope", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "user", { cursor: "0.1" }));
    f.applyEvent("message", wire(2, "user", { cursor: "0.2", status: "rejected" }));
    f.applyEvent("message", wire(2, "user", { cursor: "0.3", status: "restricted" }));
    f.annotate(2, { editOf: 1 });
    const v = f.value();
    expect(isChatValue(v)).toBe(true);
    expect(v.entries.every((e) => e.editOf === undefined)).toBe(true);
  });

  it("the value carries what the source knows of whose turns these are", () => {
    expect(new ChatFeed({ mode: "owner" }).value().mode).toBe("owner");
    expect(new ChatFeed().value().mode).toBeUndefined();
  });
});

describe("fix round 2: the accepted-turn binding and cursorless sources", () => {
  it("alice accepted at 0.2, bob rejected at 0.3 on the same turn, viewer alice: alice's live text SHOWS", () => {
    const f = new ChatFeed({ viewer: { actor: "alice" }, mode: "shared" });
    f.applyEvent("message", wire(1, "user", { cursor: "0.2", asker: { actor: "alice" } }));
    f.applyEvent(
      "message",
      wire(1, "user", { cursor: "0.3", status: "rejected", asker: { actor: "bob" }, text: "" })
    );
    expect(f.applyEvent("delta", { turn: 1, text: "for alice" })).toMatchObject({ changed: true });
    // and in the other arrival order (rejected first), the first accepted one still wins
    const g = new ChatFeed({ viewer: { actor: "alice" }, mode: "shared" });
    g.applyEvent(
      "message",
      wire(1, "user", { cursor: "0.1", status: "rejected", asker: { actor: "bob" }, text: "" })
    );
    g.applyEvent("message", wire(1, "user", { cursor: "0.2", asker: { actor: "alice" } }));
    expect(g.applyEvent("delta", { turn: 1, text: "for alice" })).toMatchObject({ changed: true });
  });

  it("a source with neither cursor nor ord: a rejected entry has its own slot and never takes the accepted turn's", () => {
    const f = new ChatFeed();
    f.applyEvent("message", {
      turn: 1,
      role: "user",
      status: "rejected",
      reason: "stale",
      text: "x",
    });
    f.applyEvent("message", { turn: 1, role: "user", status: "complete", text: "the real one" });
    expect(f.value().entries.map((e) => [e.id, e.status])).toEqual([
      ["t1.rejected", "rejected"],
      ["t1.user", "complete"],
    ]);
    expect(isChatValue(f.value())).toBe(true);
  });

  it("one log position is one entry: seen without and then with a record id (or the reverse) does not duplicate", () => {
    const f = new ChatFeed();
    f.applyEvent("message", wire(1, "user", { cursor: "0.2" }));
    expect(f.applyEvent("message", wire(1, "user", { cursor: "0.2", ord: 5 }))).toMatchObject({
      changed: false,
    });
    const g = new ChatFeed();
    g.applyEvent("message", wire(1, "user", { cursor: "0.2", ord: 5 }));
    g.applyEvent("message", wire(1, "user", { cursor: "0.2" }));
    g.applyHistory(page([wire(1, "user", { cursor: "0.2" })]), "backward");
    expect(g.value().entries.map((e) => e.id)).toEqual(["m5"]);
    // a placeholder seen by position is still upgraded when the real entry arrives with an ord
    const h = new ChatFeed();
    h.applyEvent("message", wire(1, "user", { cursor: "0.2", status: "restricted" }));
    h.applyEvent("message", wire(1, "user", { cursor: "0.2", ord: 5 }));
    expect(h.value().entries.map((e) => [e.id, e.status])).toEqual([["u0.2", "complete"]]);
  });
});

describe("loom R17b wire: rejected user messages on turn 0, `ord` ids, `editOfTurn`", () => {
  it("a rejected user message recorded on turn 0 is KEPT (keyed by ord) so the user sees why, and the value stays valid", () => {
    const f = new ChatFeed({ viewer: { actor: "alice" }, mode: "owner" });
    f.applyEvent("message", {
      turn: 1,
      role: "user",
      text: "first",
      status: "complete",
      ord: 1,
      cursor: "0.1",
    });
    f.applyEvent("message", {
      turn: 1,
      role: "assistant",
      text: "ok",
      status: "complete",
      ord: 2,
      cursor: "0.2",
    });
    f.applyEvent("message", {
      turn: 0,
      role: "user",
      text: "x",
      status: "rejected",
      reason: "edit-invalid",
      ord: 3,
      cursor: "0.3",
    });
    const v = f.value();
    const rejected = v.entries.find((e) => e.id === "m3");
    expect(rejected).toMatchObject({
      turn: 0,
      role: "user",
      status: "rejected",
      reason: "edit-invalid",
    });
    expect(rejected?.parts).toBeUndefined(); // a rejected message's text is never shown
    expect(isChatValue(v)).toBe(true);
  });

  it("turn 0 is accepted ONLY for a rejected user message", () => {
    expect(
      chatEntryFromWire({ turn: 0, role: "user", status: "complete", text: "x", ord: 1 })
    ).toBeUndefined();
    expect(
      chatEntryFromWire({ turn: 0, role: "assistant", status: "rejected", ord: 1 })
    ).toBeUndefined();
    expect(
      chatEntryFromWire({ turn: -1, role: "user", status: "rejected", ord: 1 })
    ).toBeUndefined();
    expect(chatEntryFromWire({ turn: 0, role: "user", status: "rejected", ord: 1 })).toMatchObject({
      turn: 0,
    });
  });

  it("the edit label is the edited TURN (`editOfTurn`), never loom's record ord (`editOf`)", () => {
    const e = chatEntryFromWire({
      turn: 3,
      role: "user",
      status: "complete",
      text: "fixed",
      ord: 5,
      editOf: 3,
      editOfTurn: 2,
    });
    expect(e?.editOf).toBe(2);
    const onlyOrd = chatEntryFromWire({
      turn: 10,
      role: "user",
      status: "complete",
      text: "fixed",
      ord: 20,
      editOf: 3,
    });
    expect(onlyOrd?.editOf).toBeUndefined();
  });
});
