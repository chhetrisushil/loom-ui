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
import { SplitHydrationController } from "./split/client";
import { serveHandle } from "./split/index";
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

  it("publishes a transcript whose assistant text says markdown, and refuses markdown on a person's turn", async () => {
    const md = {
      entries: [
        {
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "complete",
          parts: [{ type: "text", text: "**x**", format: "markdown" }],
        },
      ],
    };
    const ok = rig(md);
    ok.ctl.load(exp(shapeSpec()));
    await flush();
    expect(ok.store.status("h")?.state).toBe("ready");
    expect(ok.store.value("h")).toEqual(md);
    const bad = rig({
      entries: [
        {
          id: "t1.user",
          turn: 1,
          role: "user",
          status: "complete",
          parts: [{ type: "text", text: "SECRET", format: "markdown" }],
        },
      ],
    });
    bad.ctl.load(exp(shapeSpec()));
    await flush();
    expect(bad.store.status("h")?.state).not.toBe("ready");
    expect(bad.store.value("h")).toBeUndefined();
    expect(JSON.stringify(bad.store.state())).not.toContain("SECRET");
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
    expect(h.published.at(-1)?.value.entries.map((e) => e.id)).toEqual(["u0.2", "t1.assistant"]);
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
});

// ── fix round 1 ───────────────────────────────────────────────────────────────────────────────────

describe("P2-1: publishChat goes through the controller's gate, never straight to the store", () => {
  const expWith = (sensitivity?: "secret") => {
    const e = exp(shapeSpec());
    const root = e.root as ContainerNode;
    const chat = root.children[0] as SemanticNode & { binding: { handle: string; priority: "P0" } };
    return {
      ...e,
      root: {
        ...root,
        children: [{ ...chat, binding: { ...chat.binding, ...(sensitivity && { sensitivity }) } }],
      },
    } as Experience;
  };
  const ctlFor = (e: Experience, viewer?: { clearance?: "internal" | "secret" }) => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new HydrationController({
      contentRefArgs: "none" as const,
      invoker: new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => GOOD),
      store,
      outputKinds: { catalog, surface: "web" },
      ...(viewer !== undefined && { viewer }),
    });
    ctl.load(e);
    return { store, ctl };
  };

  it("writes a valid transcript to a bound handle: pending while a reply streams, ready once durable", async () => {
    const { store, ctl } = ctlFor(expWith());
    await flush();
    const publish = publishChat(ctl, "h");
    publish(GOOD, { streaming: true });
    expect(store.status("h")?.state).toBe("pending");
    publish(GOOD, { streaming: false });
    expect(store.status("h")?.state).toBe("ready");
  });

  it("a SECRET-bound Chat for an internal viewer is refused: nothing is written, the finding names nothing", async () => {
    const { store, ctl } = ctlFor(expWith("secret"), { clearance: "internal" });
    await flush();
    const seen: string[] = [];
    publishChat(ctl, "h", (f) => seen.push(`${f.code}: ${f.message}`))(
      {
        entries: [
          {
            id: "t1.assistant",
            turn: 1,
            role: "assistant",
            status: "complete",
            parts: [{ type: "text", text: "LEAK" }],
          },
        ],
      },
      { streaming: false }
    );
    expect(store.value("h")).toBeUndefined();
    expect(store.status("h")).toBeUndefined();
    expect(JSON.stringify(store.state())).not.toContain("LEAK");
    expect(seen).toEqual(["restricted: this data is restricted for the current viewer"]);
    // a cleared viewer may
    const ok = ctlFor(expWith("secret"), { clearance: "secret" });
    await flush();
    publishChat(ok.ctl, "h")(GOOD, { streaming: false });
    expect(ok.store.value("h")).toEqual(GOOD);
  });

  it("an unbound handle, a reserved handle and a handle of another kind are refused", async () => {
    const { store, ctl } = ctlFor(expWith());
    await flush();
    const seen: string[] = [];
    for (const h of ["ghost", "__proto__", "constructor"])
      publishChat(ctl, h, (f) => seen.push(f.code))(GOOD, { streaming: false });
    expect(seen).toEqual(["publish-unbound", "publish-unbound", "publish-unbound"]);
    expect(store.handles().filter((h) => h !== "h")).toEqual([]);
    // a handle whose widget is not a Chat
    const media = ctlFor({
      ...expWith(),
      root: {
        ...(expWith().root as ContainerNode),
        children: [
          { ...(expWith().root as ContainerNode).children[0], type: "Image" } as SemanticNode,
        ],
      },
    } as Experience);
    await flush();
    expect(media.ctl.publishValue("h", GOOD, { kind: "Chat" })).toMatchObject({
      ok: false,
      finding: { code: "publish-kind-mismatch" },
    });
  });

  it("a value that fails the ChatValue contract is refused, not published", async () => {
    const { store, ctl } = ctlFor(expWith());
    await flush();
    const before = store.value("h");
    for (const bad of [
      "plain string",
      { entries: [], classes: ["x"] },
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
    ]) {
      const r = ctl.publishValue("h", bad, { state: "ready", kind: "Chat" });
      expect(r.ok).toBe(false);
    }
    expect(store.value("h")).toEqual(before);
    expect(JSON.stringify(store.state())).not.toContain("SECRET");
  });

  it("the split (browser) controller only publishes to a handle the server LISTED, and checks the contract", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new SplitHydrationController({
      store,
      loader: { load: async () => ({ state: "pending" }) as never, loadMany: async () => [] },
    });
    ctl.load({
      experienceId: "exp-1",
      versionHash: "sha256:v1",
      handles: [{ handle: "h", priority: "P2", params: [], revision: "r1" }],
    });
    expect(ctl.publishValue("ghost", GOOD, { kind: "Chat" })).toMatchObject({
      ok: false,
      finding: { code: "publish-unbound" },
    });
    expect(ctl.publishValue("h", "bad", { kind: "Chat" }).ok).toBe(false);
    expect(ctl.publishValue("h", GOOD, { kind: "Nope" }).ok).toBe(false);
    expect(ctl.publishValue("h", GOOD, { kind: "Chat", state: "pending" })).toEqual({ ok: true });
    expect(store.status("h")?.state).toBe("pending");
    ctl.dispose();
    expect(ctl.publishValue("h", GOOD, { kind: "Chat" }).ok).toBe(false);
  });
});

describe("P3-4: the split server forces the Chat contract whatever the provider declared", () => {
  const serveChat = (value: unknown, withKinds: boolean) => {
    const e = exp(shapeSpec());
    return serveHandle(
      e,
      { experienceId: e.experienceId, versionHash: e.versionHash, handle: "h", params: {} },
      {
        contentRefArgs: "none" as const,
        invoker: new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => value),
        now: 1,
        ...(withKinds && { outputKinds: { catalog, surface: "web" as const } }),
      }
    );
  };
  for (const withKinds of [true, false]) {
    it(`never serves a shape-mode value that breaks the contract (outputKinds ${withKinds ? "given" : "ABSENT: by node type"})`, async () => {
      for (const bad of [
        "a string",
        { entries: [], classes: ["secret"] },
        {
          entries: [
            {
              id: "t1.assistant",
              turn: 1,
              role: "assistant",
              status: "restricted",
              parts: [{ type: "text", text: "LEAKED" }],
            },
          ],
        },
      ]) {
        const r = await serveChat(bad, withKinds);
        expect(r.state).not.toBe("ready");
        expect(JSON.stringify(r)).not.toContain("LEAKED");
      }
      expect((await serveChat(GOOD, withKinds)).state).toBe("ready");
    });
  }
});

describe("P3-11: reconnecting and the first page", () => {
  const pageOf = { "direction=backward": { entries: [wire(1, "user")], done: true } };
  function timed(pages: Record<string, unknown>, failFirst = 0) {
    const calls = 0;
    const h = harness(pages);
    return { calls: () => calls, h, failFirst };
  }

  it("a `reconnect` event never reopens at 0 ms, and a server that recycles right after opening is backed off", async () => {
    const delays: number[] = [];
    const feed = new ChatFeed();
    const sources: FakeSource[] = [];
    const pending: Array<() => void> = [];
    const conn = connectConversation({
      baseUrl: "/c",
      feed,
      fetch: async () => ({ ok: true, json: async () => pageOf["direction=backward"] }),
      openStream: (u) => {
        const s = new FakeSource(u);
        sources.push(s);
        return s;
      },
      publish: () => {},
      now: () => 1000, // frozen: every reconnect is "right after opening"
      setTimer: (fn, ms) => {
        delays.push(ms);
        pending.push(fn);
        return () => {};
      },
    });
    await conn.start();
    for (let i = 0; i < 4; i++) {
      (sources.at(-1) as FakeSource).emit("reconnect", {});
      pending.shift()?.();
    }
    expect(delays.every((d) => d >= 250)).toBe(true);
    expect(delays[0]).toBeGreaterThanOrEqual(250);
    expect(delays[3]).toBeGreaterThan(delays[0] as number); // a loop backs off
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
  });

  it("a healthy stream recycled by the server reopens after the floor (250 ms), never at 0", async () => {
    const delays: number[] = [];
    let t = 0;
    const sources: FakeSource[] = [];
    const conn = connectConversation({
      baseUrl: "/c",
      feed: new ChatFeed(),
      fetch: async () => ({ ok: true, json: async () => pageOf["direction=backward"] }),
      openStream: (u) => {
        const s = new FakeSource(u);
        sources.push(s);
        return s;
      },
      publish: () => {},
      now: () => t,
      setTimer: (fn, ms) => {
        delays.push(ms);
        return () => {};
      },
    });
    await conn.start();
    t = 15 * 60_000; // the server's 15 minute lifetime
    (sources[0] as FakeSource).emit("reconnect", {});
    expect(delays).toEqual([250]);
  });

  it("a failed first page is RETRIED with backoff instead of giving up, and the stream opens once it loads", async () => {
    const delays: number[] = [];
    const timers: Array<() => void> = [];
    let n = 0;
    const sources: FakeSource[] = [];
    const feed = new ChatFeed();
    const conn = connectConversation({
      baseUrl: "/c",
      feed,
      fetch: async () => {
        n++;
        return n < 3
          ? { ok: false, json: async () => ({}) }
          : { ok: true, json: async () => pageOf["direction=backward"] };
      },
      openStream: (u) => {
        const s = new FakeSource(u);
        sources.push(s);
        return s;
      },
      publish: () => {},
      setTimer: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
        return () => {};
      },
    });
    await conn.start();
    expect(sources).toHaveLength(0);
    expect(delays).toEqual([2000]); // the first wait is the documented base
    timers.shift()?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(delays.length).toBe(2);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    timers.shift()?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(sources).toHaveLength(1);
    expect(feed.value().entries).toHaveLength(1);
    conn.close();
  });
});

describe("fix round 2: the backoff resets after a healthy stream, with an injected clock", () => {
  class ErrSource extends FakeSource {
    onerror?: () => void;
  }
  it("platform give-ups: the first wait is the base, consecutive quick ones double, and a stream that was up for a while starts afresh", async () => {
    const delays: number[] = [];
    const sources: ErrSource[] = [];
    const timers: Array<() => void> = [];
    let t = 0;
    const conn = connectConversation({
      baseUrl: "/c",
      feed: new ChatFeed(),
      fetch: async () => ({
        ok: true,
        json: async () => ({ entries: [wire(1, "user")], done: true }),
      }),
      openStream: (u) => {
        const s = new ErrSource(u);
        sources.push(s);
        return s;
      },
      publish: () => {},
      now: () => t,
      setTimer: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
        return () => {};
      },
    });
    await conn.start();
    const giveUp = () => {
      const s = sources.at(-1) as ErrSource;
      s.readyState = 2;
      s.onerror?.();
      timers.shift()?.();
    };
    giveUp(); // up for 0 ms
    giveUp();
    giveUp();
    expect(delays).toEqual([2000, 4000, 8000]);
    t += 60_000; // this stream stayed up for a minute, idle but healthy
    giveUp();
    expect(delays.at(-1)).toBe(2000); // NOT 16 000: the streak is over
    giveUp(); // quick again
    expect(delays.at(-1)).toBe(4000);
  });

  it("a server recycle after a long healthy stream is a plain 250 ms reopen and clears the streak", async () => {
    const delays: number[] = [];
    const sources: ErrSource[] = [];
    const timers: Array<() => void> = [];
    let t = 0;
    const conn = connectConversation({
      baseUrl: "/c",
      feed: new ChatFeed(),
      fetch: async () => ({
        ok: true,
        json: async () => ({ entries: [wire(1, "user")], done: true }),
      }),
      openStream: (u) => {
        const s = new ErrSource(u);
        sources.push(s);
        return s;
      },
      publish: () => {},
      now: () => t,
      setTimer: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
        return () => {};
      },
    });
    await conn.start();
    const s0 = sources[0] as ErrSource;
    s0.readyState = 2;
    s0.onerror?.(); // quick failure: 2000
    timers.shift()?.();
    t += 20_000;
    (sources.at(-1) as ErrSource).emit("reconnect", {});
    expect(delays).toEqual([2000, 250]);
    timers.shift()?.();
    const again = sources.at(-1) as ErrSource;
    again.readyState = 2;
    again.onerror?.();
    expect(delays.at(-1)).toBe(2000); // the streak was cleared by the healthy stream
  });
});
