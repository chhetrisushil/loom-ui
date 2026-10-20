import { ChatFeed } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { type EventSourceLike, connectConversation } from "./chatSource";

// connectConversation + reasoning (loom ADR 0133 D6): the two live events are routed to the feed, and the
// durable `/reasoning` route is fetched for ONE reply, lazily, only when the host asks.

const wire = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  turn,
  role,
  text: `${role} ${turn}`,
  status: "complete",
  cursor: `0.${turn * 2 + (role === "user" ? 0 : 1)}`,
  ...over,
});

class FakeSource implements EventSourceLike {
  readyState = 1;
  readonly handlers = new Map<string, Array<(e: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (e: { data?: unknown }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  close(): void {}
  emit(type: string, data: unknown): void {
    for (const h of this.handlers.get(type) ?? []) h({ data: JSON.stringify(data) });
  }
}

const DURABLE = {
  steps: [
    {
      stepId: "s",
      recordedAttempt: 1,
      attempts: [
        { attempt: 1, recorded: true, parts: [{ kind: "text", status: "ok", text: "because" }] },
      ],
    },
  ],
};

function harness(opts: {
  feed?: ConstructorParameters<typeof ChatFeed>[0];
  reasoning?: boolean;
  reasoningReply?: { ok: boolean; status?: number; body?: unknown } | "throw";
}) {
  const feed = new ChatFeed({ mode: "owner", ...opts.feed });
  const urls: string[] = [];
  const sources: FakeSource[] = [];
  const published: Array<ReturnType<ChatFeed["value"]>> = [];
  const findings: string[] = [];
  const conn = connectConversation({
    baseUrl: "/conversations/c1",
    feed,
    ...(opts.reasoning !== undefined && { reasoning: opts.reasoning }),
    fetch: async (url) => {
      urls.push(url);
      if (url.includes("/reasoning")) {
        const r = opts.reasoningReply ?? { ok: true, body: DURABLE };
        if (r === "throw") throw new Error("boom SELECT secrets");
        return {
          ok: r.ok,
          ...(r.status !== undefined && { status: r.status }),
          json: async () => r.body,
        };
      }
      return {
        ok: true,
        json: async () => ({ entries: [wire(1, "assistant"), wire(1, "user")], done: true }),
      };
    },
    openStream: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    publish: (value) => published.push(value),
    onFinding: (f) => findings.push(`${f.code}: ${f.message}`),
    setTimer: () => () => {},
  });
  return { conn, feed, urls, sources, published, findings };
}

const lastReasoning = (h: ReturnType<typeof harness>) =>
  h.published.at(-1)?.entries.find((e) => e.role === "assistant" && e.turn === 1)?.reasoning;

describe("connectConversation: live reasoning", () => {
  it("routes reasoning and reasoning-partial to the feed and publishes them", async () => {
    const h = harness({ feed: { reasoning: true } });
    await h.conn.start();
    const es = h.sources[0] as FakeSource;
    es.emit("message", wire(2, "user"));
    es.emit("reasoning", { turn: 2, text: "ab" });
    es.emit("reasoning", { turn: 2, text: "cd" });
    expect(h.published.at(-1)?.entries.at(-1)?.reasoning?.text).toBe("abcd");
    // reconnect: the catch-up replaces, never appends
    es.emit("reasoning-partial", { turn: 2, text: "abcd" });
    expect(h.published.at(-1)?.entries.at(-1)?.reasoning?.text).toBe("abcd");
    expect(h.findings).toEqual([]);
  });

  it("with the feed's reasoning off the events change nothing and raise no finding", async () => {
    const h = harness({});
    await h.conn.start();
    const es = h.sources[0] as FakeSource;
    const before = h.published.length;
    es.emit("message", wire(2, "user"));
    es.emit("reasoning", { turn: 2, text: "ab" });
    es.emit("reasoning-partial", { turn: 2, text: "ab" });
    expect(JSON.stringify(h.published.at(-1))).not.toContain('ab"');
    expect(h.published.length).toBe(before + 1); // only the message
    expect(h.findings).toEqual([]);
  });
});

describe("connectConversation: the durable reasoning route", () => {
  it("fetches nothing until asked: the reply is only OFFERED (unloaded)", async () => {
    const h = harness({ feed: { reasoning: { durable: true } }, reasoning: true });
    await h.conn.start();
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toEqual([]);
    expect(lastReasoning(h)?.status).toBe("unloaded"); // offered, not fetched
  });

  it("marks loading, then publishes the stored reasoning; a second ask is a no-op", async () => {
    const h = harness({ feed: { reasoning: { durable: true } }, reasoning: true });
    await h.conn.start();
    const p = h.conn.loadReasoning("0.3");
    expect(lastReasoning(h)?.status).toBe("loading");
    await p;
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toEqual([
      "/conversations/c1/reasoning?cursor=0.3",
    ]);
    expect(lastReasoning(h)).toMatchObject({ text: "because", kind: "text", streaming: false });
    await h.conn.loadReasoning("0.3");
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toHaveLength(1);
  });

  it("concurrent asks make one request", async () => {
    const h = harness({ feed: { reasoning: { durable: true } }, reasoning: true });
    await h.conn.start();
    await Promise.all([h.conn.loadReasoning("0.3"), h.conn.loadReasoning("0.3")]);
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toHaveLength(1);
  });

  it("a 404 is a settled 'none for you': unavailable, no finding, not retried", async () => {
    const h = harness({
      feed: { reasoning: { durable: true } },
      reasoning: true,
      reasoningReply: { ok: false, status: 404, body: { error: "SELECT * FROM secrets" } },
    });
    await h.conn.start();
    await h.conn.loadReasoning("0.3");
    expect(lastReasoning(h)?.status).toBe("unavailable");
    expect(h.findings).toEqual([]);
    await h.conn.loadReasoning("0.3");
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toHaveLength(1);
  });

  it("a transport failure is a fixed finding (no error text) and the reply can be asked again", async () => {
    const h = harness({
      feed: { reasoning: { durable: true } },
      reasoning: true,
      reasoningReply: "throw",
    });
    await h.conn.start();
    await h.conn.loadReasoning("0.3");
    expect(lastReasoning(h)?.status).toBe("unloaded");
    expect(h.findings).toEqual(["reasoning-unavailable: the reasoning could not be loaded"]);
    expect(h.findings.join()).not.toContain("secrets");
    await h.conn.loadReasoning("0.3");
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toHaveLength(2);
  });

  it("does nothing when the connection did not enable reasoning, or the feed is not durable", async () => {
    const a = harness({ feed: { reasoning: { durable: true } } });
    await a.conn.start();
    await a.conn.loadReasoning("0.3");
    expect(a.urls.filter((u) => u.includes("/reasoning"))).toEqual([]);
    const b = harness({ feed: { reasoning: true }, reasoning: true });
    await b.conn.start();
    await b.conn.loadReasoning("0.3");
    expect(b.urls.filter((u) => u.includes("/reasoning"))).toEqual([]);
  });

  it("a cursor that is not in the transcript is never fetched", async () => {
    const h = harness({ feed: { reasoning: { durable: true } }, reasoning: true });
    await h.conn.start();
    await h.conn.loadReasoning("0.2"); // the user's turn
    await h.conn.loadReasoning("7.7");
    await h.conn.loadReasoning("../../x");
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toEqual([]);
  });

  it("a closed connection fetches nothing", async () => {
    const h = harness({ feed: { reasoning: { durable: true } }, reasoning: true });
    await h.conn.start();
    h.conn.close();
    await h.conn.loadReasoning("0.3");
    expect(h.urls.filter((u) => u.includes("/reasoning"))).toEqual([]);
  });
});
