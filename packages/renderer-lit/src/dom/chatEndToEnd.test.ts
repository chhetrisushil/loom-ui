import {
  ChatFeed,
  type ContainerNode,
  type Experience,
  type SemanticNode,
  SubmitLedger,
  chatCatalogEntries,
  compile,
  conversationTarget,
  createWriteBack,
  defineSemanticCatalog,
  genesis,
  inputSpecsOf,
} from "@loom-ui/core";
import {
  HYDRATION_PROJECTION_ID,
  HydrationStore,
  SplitHydrationController,
  publishChat,
} from "@loom-ui/hydration";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatLitRegistry } from "../chat";
import { renderBlueprintDom } from "./index";

// U8 end to end on the web surface: compile -> hydration store (fed by a ChatFeed) -> DOM, and the
// way back: widget -> stamped action -> the HOST's write-back (re-validate, freshness, dedupe) ->
// a conversation's sendTurn. The host's answer is what the widget waits for.

const catalog = defineSemanticCatalog({ id: "chat.e2e", entries: chatCatalogEntries() });
const g = genesis({
  experienceId: "u8",
  intent: { objective: "talk", source: "user" },
  meta: { author: "t", createdAt: "2026-10-09T00:00:00Z", sourceKind: "prompt" },
});
const node = (
  id: string,
  order: string,
  type: string,
  props: Record<string, unknown>,
  handle?: string
): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type,
  typeVersion: "1.0.0",
  span: 12,
  props,
  ...(handle !== undefined && { binding: { handle, priority: "P1" as const } }),
});
const mkExp = (versionHash: string): Experience => ({
  ...g,
  versionHash,
  root: {
    ...(g.root as ContainerNode),
    children: [
      node("chat", "A", "Chat", { editable: true }, "h_chat"),
      node("composer", "B", "TextInput", { label: "Message" }),
      node("pick", "C", "SelectInput", {
        label: "Mode",
        options: [
          { value: "fast", label: "Fast" },
          { value: "deep", label: "Deep" },
        ],
      }),
    ],
  },
  providers: {
    h_chat: {
      handle: "h_chat",
      executionGraph: [],
      reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
      outputShapeHash: "sha256:o",
      cachePolicy: { ttlSeconds: 60, scope: "global" as const },
    },
  },
});
const wire = (turn: number, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  turn,
  role,
  text: `${role} ${turn}`,
  status: "complete",
  cursor: `0.${turn * 2 + (role === "user" ? 0 : 1)}`,
  ...over,
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const shadow = (host: HTMLElement, widgetId: string): ShadowRoot =>
  (host.querySelector(`[data-widget-id='${widgetId}']`)?.firstElementChild as HTMLElement)
    .shadowRoot as ShadowRoot;

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function rig(headHash: string, renderedHash = headHash) {
  const exp = mkExp(renderedHash);
  const r = compile(exp, {
    surface: "web",
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: "1.0.0",
  });
  expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "u8" });
  const feed = new ChatFeed({ viewer: { actor: "alice" }, mode: "owner" });
  // The page publishes THROUGH a controller's gate: only a handle the server listed, only a valid transcript.
  const controller = new SplitHydrationController({
    store,
    loader: { load: async () => ({ state: "pending" }) as never, loadMany: async () => [] },
  });
  controller.load({
    experienceId: "u8",
    versionHash: headHash,
    handles: [{ handle: "h_chat", priority: "P2", params: [], revision: "r1" }],
  });
  const publish = publishChat(controller, "h_chat");
  const sendTurn = vi.fn(async (_text: string, _o: { messageId: string }) => undefined);
  const specs = inputSpecsOf(mkExp(headHash), catalog, "web");
  const ledger = new SubmitLedger();
  const writeBack = createWriteBack({
    specOf: (id) => specs.get(id),
    ledger,
    canEdit: (turn) => turn === 1,
    routes: { composer: conversationTarget(sendTurn), chat: conversationTarget(sendTurn) },
  });
  const head = { experienceId: "u8", versionHash: headHash };
  const outcomes: unknown[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = renderBlueprintDom(host, r.blueprint, {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: createChatLitRegistry(),
    onAction: async (a) => {
      const out = await writeBack.handle(a, { principal: "t/alice", current: head });
      outcomes.push(out);
      return out;
    },
  });
  const apply = (name: string, data: unknown) => {
    const res = feed.applyEvent(name, data);
    if (res.ok && res.changed) publish(feed.value(), { streaming: feed.streaming });
  };
  return { host, handle, store, feed, publish, apply, sendTurn, outcomes, r, controller };
}

describe("U8: chat through compile, hydration and the DOM", () => {
  it("a conversation draws from the feed, streams a reply live, and a restricted entry is a bare placeholder", async () => {
    const t = rig("sha256:v1");
    t.feed.applyHistory(
      {
        entries: [
          wire(2, "assistant", { status: "restricted", text: "", asker: { actor: "carol" } }),
          wire(2, "user", { status: "restricted", text: "", asker: { actor: "carol" } }),
          wire(1, "assistant"),
          wire(1, "user"),
        ],
        done: true,
      },
      "backward"
    );
    t.publish(t.feed.value(), { streaming: false });
    t.apply("message", wire(3, "user"));
    t.apply("delta", { turn: 3, text: "Think" });
    t.apply("delta", { turn: 3, text: "ing" });
    t.apply("delta", { turn: 2, text: "TOP SECRET LIVE TEXT" }); // a restricted turn's live text: never drawn
    await tick();
    const root = shadow(t.host, "chat");
    const arts = [...root.querySelectorAll("article")];
    expect(arts.map((a) => a.getAttribute("data-status"))).toEqual([
      "complete",
      "complete",
      "restricted",
      "restricted",
      "complete",
      "streaming",
    ]);
    expect(root.querySelector(".log")?.getAttribute("aria-busy")).toBe("true");
    expect(root.textContent).toContain("Thinking");
    expect(root.innerHTML).not.toContain("TOP SECRET");
    t.apply("message", wire(3, "assistant", { text: "Thinking done" }));
    await tick();
    expect(root.querySelector(".log")?.getAttribute("aria-busy")).toBe("false");
    expect(root.textContent).toContain("Thinking done");
    t.handle.dispose();
  });

  it("send: the composer's submit is stamped, accepted by the host, and becomes ONE turn whose messageId is the idempotency key", async () => {
    const t = rig("sha256:v1");
    await tick();
    const root = shadow(t.host, "composer");
    const field = root.querySelector("#field") as HTMLInputElement;
    field.value = "hello agent";
    field.dispatchEvent(new Event("input"));
    root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(t.sendTurn).toHaveBeenCalledTimes(1);
    expect(t.sendTurn.mock.calls[0]?.[0]).toBe("hello agent");
    expect(t.sendTurn.mock.calls[0]?.[1].messageId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(field.value).toBe("");
    expect(root.querySelector("#status")?.textContent).toBe("Sent");
    t.handle.dispose();
  });

  it("a STALE view is refused by the host: nothing is sent, the draft is kept, and the user is told the view changed", async () => {
    // The page was rendered from version v1; the host's head has since moved to v2.
    const t = rig("sha256:v2", "sha256:v1");
    await tick();
    const root = shadow(t.host, "composer");
    const field = root.querySelector("#field") as HTMLInputElement;
    field.value = "act on what I saw";
    field.dispatchEvent(new Event("input"));
    root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(t.sendTurn).not.toHaveBeenCalled();
    expect(t.outcomes).toEqual([{ ok: false, reason: "stale" }]);
    expect(field.value).toBe("act on what I saw");
    expect(root.querySelector("#status")?.textContent).toBe(
      "The view changed. Review it and send again."
    );
    t.handle.dispose();
  });

  it("a retry after a failed write is accepted once; an exact replay of an accepted action is deduped", async () => {
    const t = rig("sha256:v1");
    await tick();
    let fail = true;
    t.sendTurn.mockImplementation(async () => {
      if (fail) throw new Error("db down");
    });
    const root = shadow(t.host, "composer");
    const field = root.querySelector("#field") as HTMLInputElement;
    field.value = "retry me";
    field.dispatchEvent(new Event("input"));
    root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(root.querySelector("#status")?.textContent).toBe("Not sent. Try again.");
    fail = false;
    root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(t.sendTurn).toHaveBeenCalledTimes(2);
    expect(t.sendTurn.mock.calls[0]?.[1].messageId).toBe(t.sendTurn.mock.calls[1]?.[1].messageId);
    expect(field.value).toBe("");
    t.handle.dispose();
  });

  it("edit: the user's own turn is edited into a NEW turn through the host; the old turn stays", async () => {
    const t = rig("sha256:v1");
    t.feed.applyHistory(
      { entries: [wire(1, "assistant"), wire(1, "user", { text: "what is 2+2?" })], done: true },
      "backward"
    );
    t.publish(t.feed.value(), { streaming: false });
    await tick();
    const root = shadow(t.host, "chat");
    (root.querySelector("[data-edit-button='1']") as HTMLButtonElement).click();
    await tick();
    const ta = root.querySelector("[data-edit-field]") as HTMLTextAreaElement;
    expect(ta.value).toBe("what is 2+2?");
    ta.value = "what is 3+3?";
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await tick();
    expect(t.sendTurn).toHaveBeenCalledTimes(1);
    expect(t.sendTurn.mock.calls[0]?.[0]).toBe("what is 3+3?");
    // the transcript is unchanged until the NEW turn arrives from the log; then it is labelled as an edit
    expect(root.textContent).toContain("what is 2+2?");
    t.feed.annotate(2, { editOf: 1 });
    t.apply("message", wire(2, "user", { text: "what is 3+3?" }));
    await tick();
    expect(root.textContent).toContain("what is 2+2?");
    expect(root.querySelector("article[data-turn='2']")?.getAttribute("aria-label")).toBe(
      "You, edit of turn 1"
    );
    t.handle.dispose();
  });

  it("an edit of a turn the host does not allow is refused and nothing is sent", async () => {
    const t = rig("sha256:v1");
    t.feed.applyHistory(
      { entries: [wire(2, "user"), wire(1, "assistant"), wire(1, "user")], done: true },
      "backward"
    );
    t.publish(t.feed.value(), { streaming: false });
    await tick();
    const root = shadow(t.host, "chat");
    (root.querySelector("[data-edit-button='2']") as HTMLButtonElement).click(); // the host only allows turn 1
    await tick();
    (root.querySelectorAll(".editor button")[0] as HTMLButtonElement).click();
    await tick();
    expect(t.sendTurn).not.toHaveBeenCalled();
    expect(t.outcomes.at(-1)).toEqual({ ok: false, reason: "edit-not-allowed" });
    t.handle.dispose();
  });
});

describe("fix round 1", () => {
  it("rejected envelopes on the accepted turn's number do not hide the real turn, and its reply streams (loom's actual sequence)", async () => {
    const t = rig("sha256:v1");
    const rej = (cursor: string) =>
      wire(1, "user", {
        cursor,
        status: "rejected",
        reason: "unauthenticated",
        text: "FORGED TEXT",
      });
    t.apply("message", rej("0.2"));
    t.apply("message", rej("0.3"));
    t.apply("message", rej("0.4"));
    t.apply("message", wire(1, "user", { cursor: "0.5", text: "the real question" }));
    t.apply("delta", { turn: 1, text: "streaming answer" });
    await tick();
    const root = shadow(t.host, "chat");
    expect([...root.querySelectorAll("article")].map((a) => a.getAttribute("data-status"))).toEqual(
      ["rejected", "rejected", "rejected", "complete", "streaming"]
    );
    expect(root.textContent).toContain("the real question");
    expect(root.textContent).toContain("streaming answer");
    expect(root.innerHTML).not.toContain("FORGED TEXT");
    t.handle.dispose();
  });

  it("an action from a widget whose entry is gone is dropped AND answered stale (an input must not read silence as success)", async () => {
    const t = rig("sha256:v1");
    await tick();
    const el = t.host.querySelector("[data-widget-id='composer']")
      ?.firstElementChild as unknown as { onAction: (a: unknown) => unknown };
    const call = el.onAction;
    t.handle.dispose();
    expect(await call({ type: "SUBMIT_TEXT", widgetId: "composer", payload: {} })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("the page's publish is refused for a handle the server did not list", async () => {
    const t = rig("sha256:v1");
    const seen: string[] = [];
    const ghost = publishChat(t.controller, "ghost", (f) => seen.push(f.code));
    ghost(t.feed.value(), { streaming: false });
    expect(seen).toEqual(["publish-unbound"]);
    t.handle.dispose();
  });
});
