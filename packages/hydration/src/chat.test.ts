import {
  ChatFeed,
  type ContainerNode,
  type Experience,
  type ProviderSpec,
  type SemanticNode,
  chatCatalogEntries,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { type EventSourceLike, connectConversation, publishChat } from "./chatSource";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { FakeInvoker, flush, mcpStep, providerSpec } from "./testing.test-support";

// ── U8: a Chat-bound handle is contract-checked whatever its provider declared, and never a stream ──

const catalog = defineSemanticCatalog({ id: "chat", entries: chatCatalogEntries() });
const GOOD = {
  entries: [
    {
      id: "t1.user",
      turn: 1,
      role: "user",
      status: "complete",
      parts: [{ type: "text", text: "hi" }],
    },
  ],
};
const exp = (spec: ProviderSpec): Experience => {
  const g = genesis({
    experienceId: "exp-1",
    intent: { objective: "x", source: "user" },
    meta: { author: "a", createdAt: "2026-10-09T00:00:00Z", sourceKind: "test" },
  });
  const n: SemanticNode = {
    id: "chat",
    order: "a",
    kind: "semantic",
    type: "Chat",
    typeVersion: "1.0.0",
    span: 12,
    props: {},
    binding: { handle: "h", priority: "P0" },
  };
  return {
    ...g,
    versionHash: "sha256:v1",
    root: { ...(g.root as ContainerNode), children: [n] },
    providers: { h: spec },
  };
};
const rig = (value: unknown) => {
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
  const ctl = new HydrationController({
    contentRefArgs: "none" as const,
    invoker: new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => value),
    store,
    outputKinds: { catalog, surface: "web" },
  });
  return { store, ctl };
};
const shapeSpec = () => providerSpec("h", [mcpStep("s", "t")]);

describe("a Chat-bound handle at the data boundary", () => {
  it("publishes a well-formed transcript", async () => {
    const r = rig(GOOD);
    r.ctl.load(exp(shapeSpec()));
    await flush();
    expect(r.store.status("h")?.state).toBe("ready");
    expect(r.store.value("h")).toEqual(GOOD);
  });

  it.each([
    [
      "a restricted entry that carries text",
      {
        entries: [
          {
            id: "t1.assistant",
            turn: 1,
            role: "assistant",
            status: "restricted",
            parts: [{ type: "text", text: "SECRET" }],
          },
        ],
      },
    ],
    ["an unknown field riding along", { entries: [], classes: ["secret"] }],
    ["a bare string", "hello there"],
    ["markup as the whole value", "<img src=x onerror=alert(1)>"],
  ])("a shape-mode provider returning %s is never published", async (_l, bad) => {
    const r = rig(bad);
    r.ctl.load(exp(shapeSpec()));
    await flush();
    expect(r.store.status("h")?.state).not.toBe("ready");
    expect(r.store.value("h")).toBeUndefined();
    expect(JSON.stringify(r.store.state())).not.toContain("SECRET");
  });

  it("is never streamable: a text chunk cannot overwrite a transcript", async () => {
    const r = rig(GOOD);
    r.ctl.load(exp(shapeSpec()));
    await flush();
    const res = r.ctl.append("h", { seq: 0, text: "overwritten" });
    expect(res.ok).toBe(false);
    expect(r.store.value("h")).toEqual(GOOD);
  });
});

// ── connectConversation: the browser's read half over loom's history + SSE routes ────────────────

const wire = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  turn,
  role,
  text: `${role} ${turn}`,
  status: "complete",
  cursor: `0.${turn * 2 + (role === "user" ? 0 : 1)}`,
  executionId: "conv",
  ...over,
});

class FakeSource implements EventSourceLike {
  readyState = 1;
  closed = false;
  readonly handlers = new Map<string, Array<(e: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (e: { data?: unknown }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown, raw = false): void {
    for (const h of this.handlers.get(type) ?? []) h({ data: raw ? data : JSON.stringify(data) });
  }
}

function harness(pages: Record<string, unknown>) {
  const feed = new ChatFeed({ viewer: { actor: "me" } });
  const urls: string[] = [];
  const sources: FakeSource[] = [];
  const published: Array<{ value: ReturnType<ChatFeed["value"]>; streaming: boolean }> = [];
  const findings: string[] = [];
  const timers: Array<() => void> = [];
  const conn = connectConversation({
    baseUrl: "/conversations/c1",
    feed,
    fetch: async (url) => {
      urls.push(url);
      const hit = Object.entries(pages).find(([k]) => url.includes(k));
      if (hit === undefined)
        return { ok: false, json: async () => ({ error: "SELECT * FROM secrets" }) };
      return { ok: true, json: async () => hit[1] };
    },
    openStream: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    publish: (value, meta) => published.push({ value, streaming: meta.streaming }),
    onFinding: (f) => findings.push(`${f.code}: ${f.message}`),
    setTimer: (fn) => {
      timers.push(fn);
      return () => {};
    },
  });
  return { conn, feed, urls, sources, published, findings, timers };
}

describe("connectConversation", () => {
  it("loads the newest page, then opens the stream from where it ended, and folds events into the published value", async () => {
    const h = harness({
      "direction=backward": { entries: [wire(1, "assistant"), wire(1, "user")], done: true },
    });
    await h.conn.start();
    expect(h.urls[0]).toBe("/conversations/c1/history?direction=backward&limit=50");
    expect(h.published.at(-1)?.value.entries.map((e) => e.id)).toEqual(["t1.user", "t1.assistant"]);
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]?.url).toBe("/conversations/c1/events?cursor=0.3");
    const es = h.sources[0] as FakeSource;
    es.emit("status", { state: "open", running: false });
    es.emit("message", wire(2, "user"));
    es.emit("delta", { turn: 2, text: "Hel" });
    es.emit("delta", { turn: 2, text: "lo" });
    const last = h.published.at(-1);
    expect(last?.streaming).toBe(true);
    expect(last?.value.entries.at(-1)).toMatchObject({ id: "t2.assistant", status: "streaming" });
    es.emit("message", wire(2, "assistant", { text: "Hello!" }));
    expect(h.published.at(-1)?.streaming).toBe(false);
    expect(h.published.at(-1)?.value.entries.at(-1)).toMatchObject({ status: "complete" });
  });

  it("loads earlier turns with the feed's cursor, once at a time", async () => {
    const h = harness({
      "cursor=0.3": { entries: [wire(1, "assistant"), wire(1, "user")], done: true },
      "direction=backward&limit=50": {
        entries: [wire(2, "assistant"), wire(2, "user")],
        done: false,
        nextCursor: "0.3",
      },
    });
    await h.conn.start();
    expect(h.feed.value().older).toBe("0.3");
    await Promise.all([h.conn.loadOlder(), h.conn.loadOlder()]);
    expect(h.urls.filter((u) => u.includes("cursor=0.3"))).toHaveLength(1);
    expect(h.feed.value().entries.map((e) => e.turn)).toEqual([1, 1, 2, 2]);
    await h.conn.loadOlder(); // start reached: nothing to load
    expect(h.urls.filter((u) => u.includes("cursor="))).toHaveLength(1);
  });

  it("a failed load reports a FIXED finding: no status, no body, no exception text", async () => {
    const h = harness({});
    await h.conn.start();
    expect(h.findings).toEqual([
      "history-unavailable: the conversation history could not be loaded",
    ]);
    expect(h.findings.join()).not.toContain("secrets");
  });

  it("drops oversized and non-JSON frames, never reads an error event, and a reconnect event reopens from the cursor", async () => {
    const h = harness({ "direction=backward": { entries: [wire(1, "user")], done: true } });
    await h.conn.start();
    const es = h.sources[0] as FakeSource;
    es.emit("message", "{not json", true);
    es.emit("message", "x".repeat(300_000), true);
    es.emit("error", { error: "stack trace at /srv/app/db.ts:12 password=hunter2" });
    expect(h.findings.map((f) => f.split(":")[0])).toEqual([
      "frame-invalid",
      "frame-too-large",
      "stream-error",
    ]);
    expect(h.findings.join()).not.toContain("hunter2");
    es.emit("reconnect", {});
    expect(es.closed).toBe(true);
    h.timers.shift()?.();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1]?.url).toBe("/conversations/c1/events?cursor=0.2");
  });

  it("an event from a replaced stream is ignored, and close() stops everything", async () => {
    const h = harness({ "direction=backward": { entries: [wire(1, "user")], done: true } });
    await h.conn.start();
    const old = h.sources[0] as FakeSource;
    old.emit("reconnect", {});
    h.timers.shift()?.();
    const before = h.published.length;
    old.emit("message", wire(2, "user"));
    expect(h.published.length).toBe(before);
    h.conn.close();
    expect((h.sources[1] as FakeSource).closed).toBe(true);
    (h.sources[1] as FakeSource).emit("message", wire(3, "user"));
    expect(h.published.length).toBe(before);
  });

  it("publishChat writes the handle: pending while a reply streams, ready once durable", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    const publish = publishChat(store, "chat");
    publish(GOOD, { streaming: true });
    expect(store.status("chat")?.state).toBe("pending");
    publish(GOOD, { streaming: false });
    expect(store.status("chat")?.state).toBe("ready");
  });
});
