import { describe, expect, it, vi } from "vitest";
import {
  CHAT_REF_OPEN_ACTION,
  EDIT_TURN_ACTION,
  LOAD_OLDER_ACTION,
  LOAD_REASONING_ACTION,
  SELECT_ACTION,
  SELECT_MANY_ACTION,
  SUBMIT_FORM_ACTION,
  SUBMIT_TEXT_ACTION,
  isSubmitKey,
  newSubmitKey,
} from "./chatActions";
import {
  type InputSpec,
  SubmitLedger,
  acceptChatSubmit,
  conversationTarget,
  createWriteBack,
  paramsTarget,
  resumeTarget,
} from "./chatHost";

const head = { experienceId: "e", versionHash: "sha256:v2" };
const stamp = (over: Record<string, unknown> = {}) => ({
  blueprintId: "e@sha256:v2",
  experienceId: "e",
  versionHash: "sha256:v2",
  ...over,
});
const FIELDS = [
  { name: "reason", label: "Reason", type: "textarea" as const, required: true, maxLength: 50 },
  { name: "count", label: "Count", type: "number" as const, min: 1, max: 10 },
  { name: "urgent", label: "Urgent", type: "boolean" as const },
  {
    name: "env",
    label: "Env",
    type: "select" as const,
    options: [
      { value: "prod", label: "Prod" },
      { value: "dev", label: "Dev" },
    ],
  },
];
const SPECS: Record<string, InputSpec> = {
  composer: { kind: "TextInput", maxChars: 100 },
  form: { kind: "FormInput", fields: FIELDS },
  pick: {
    kind: "SelectInput",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  },
  chat: { kind: "Chat", editable: true },
  fixedchat: { kind: "Chat", editable: false },
};
const KEY = "key-0123456789abcdef";
const act = (
  type: string,
  widgetId: string,
  payload: unknown,
  over: Record<string, unknown> = {}
) => ({
  type,
  widgetId,
  payload,
  viewedVersion: stamp(),
  ...over,
});
const opts = (over: Record<string, unknown> = {}) => ({
  specOf: (id: string) => (Object.hasOwn(SPECS, id) ? SPECS[id] : undefined),
  principal: "t/alice",
  current: head,
  ledger: new SubmitLedger(),
  canEdit: (turn: number) => turn === 1,
  ...over,
});

describe("acceptChatSubmit", () => {
  it("accepts a fresh text submit and returns the SANITISED text", () => {
    const r = acceptChatSubmit(
      act(SUBMIT_TEXT_ACTION, "composer", { text: "hi\u202e there\u001b[2J", key: KEY }),
      opts()
    );
    expect(r).toMatchObject({
      ok: true,
      submission: { kind: "text", widgetId: "composer", key: KEY, text: "hi there[2J" },
    });
  });

  it("a STALE submit (the view was recomposed since) is refused, and burns no key", () => {
    const o = opts();
    const stale = act(
      SUBMIT_TEXT_ACTION,
      "composer",
      { text: "x", key: KEY },
      { viewedVersion: stamp({ versionHash: "sha256:v1", blueprintId: "e@sha256:v1" }) }
    );
    expect(acceptChatSubmit(stale, o)).toEqual({ ok: false, reason: "stale" });
    // the same key, on the current view, is accepted: the refusal did not claim it
    expect(
      acceptChatSubmit(act(SUBMIT_TEXT_ACTION, "composer", { text: "x", key: KEY }), o).ok
    ).toBe(true);
    // unstamped, unsealed: not fresh either
    expect(
      acceptChatSubmit(
        { type: SUBMIT_TEXT_ACTION, widgetId: "composer", payload: { text: "x", key: KEY } },
        opts()
      )
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      acceptChatSubmit(
        act(SUBMIT_TEXT_ACTION, "composer", { text: "x", key: KEY }),
        opts({ current: { experienceId: "e", versionHash: "" } })
      )
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("a repeat of a key is IN-FLIGHT until the write is committed, then a DUPLICATE; other principals and widgets are independent", () => {
    const o = opts();
    const a = act(SUBMIT_TEXT_ACTION, "composer", { text: "x", key: KEY });
    const first = acceptChatSubmit(a, o);
    expect(first.ok).toBe(true);
    // the first write may still fail: a repeat is NOT told it landed
    expect(acceptChatSubmit(a, o)).toEqual({ ok: false, reason: "in-flight" });
    first.ok && first.commit();
    expect(acceptChatSubmit(a, o)).toEqual({ ok: false, reason: "duplicate" });
    expect(acceptChatSubmit(a, { ...o, principal: "t/bob" }).ok).toBe(true);
    expect(acceptChatSubmit(act(SELECT_ACTION, "pick", { value: "a", key: KEY }), o).ok).toBe(true);
  });

  it("releasing a claim lets the user's retry (same key) through", () => {
    const o = opts();
    const a = act(SUBMIT_TEXT_ACTION, "composer", { text: "x", key: KEY });
    const r = acceptChatSubmit(a, o);
    expect(r.ok && r.release()).not.toBe(false);
    expect(acceptChatSubmit(a, o).ok).toBe(true);
  });

  it("the ledger is bounded in size and time", () => {
    let now = 0;
    const l = new SubmitLedger({ max: 3, ttlMs: 100, now: () => now });
    for (const k of ["k1", "k2", "k3", "k4"]) expect(l.claim("p", "w", k)).toBe("new");
    expect(l.size).toBe(3);
    expect(l.claim("p", "w", "k1")).toBe("new"); // evicted: the oldest is forgotten first
    expect(l.claim("p", "w", "k4")).toBe("pending");
    l.commit("p", "w", "k4");
    expect(l.claim("p", "w", "k4")).toBe("done");
    now = 500;
    expect(l.claim("p", "w", "k4")).toBe("new"); // aged out
  });

  it("refuses malformed idempotency keys, unknown widgets, mismatched widgets, junk actions", () => {
    const o = opts();
    for (const key of [
      undefined,
      "",
      "short",
      "a b c d e f g h i j k l",
      5,
      "x".repeat(200),
      "../../../../../../etc",
    ])
      expect(
        acceptChatSubmit(act(SUBMIT_TEXT_ACTION, "composer", { text: "x", key }), o),
        String(key)
      ).toEqual({ ok: false, reason: "bad-key" });
    expect(acceptChatSubmit(act(SUBMIT_TEXT_ACTION, "ghost", { text: "x", key: KEY }), o)).toEqual({
      ok: false,
      reason: "not-an-input",
    });
    expect(
      acceptChatSubmit(act(SUBMIT_TEXT_ACTION, "__proto__", { text: "x", key: KEY }), o)
    ).toEqual({ ok: false, reason: "not-an-input" });
    expect(acceptChatSubmit(act(SUBMIT_TEXT_ACTION, "pick", { text: "x", key: KEY }), o)).toEqual({
      ok: false,
      reason: "wrong-input",
    });
    for (const junk of [
      null,
      undefined,
      5,
      "s",
      [],
      {},
      { type: "OTHER", widgetId: "composer", payload: {} },
      { type: SUBMIT_TEXT_ACTION, widgetId: 5, payload: {} },
      { type: SUBMIT_TEXT_ACTION, widgetId: "composer", payload: "x" },
      { type: "toString", widgetId: "composer", payload: {} },
    ])
      expect(acceptChatSubmit(junk, o), JSON.stringify(junk)).toEqual({
        ok: false,
        reason: "not-a-submit",
      });
  });

  it("re-validates text against the HOST's spec: blank, over the widget's maxChars, not a string", () => {
    const o = opts();
    const text = (t: unknown) =>
      acceptChatSubmit(act(SUBMIT_TEXT_ACTION, "composer", { text: t, key: newSubmitKey() }), o);
    expect(text("   \n ")).toEqual({ ok: false, reason: "invalid", errors: { text: "required" } });
    expect(text("a".repeat(101))).toEqual({
      ok: false,
      reason: "invalid",
      errors: { text: "too-long" },
    });
    expect(text(5)).toEqual({ ok: false, reason: "invalid", errors: { text: "type" } });
    expect(text({ toString: () => "x" })).toMatchObject({ ok: false });
    expect(text("a".repeat(100)).ok).toBe(true);
    // a host ceiling below the widget's own wins
    expect(
      acceptChatSubmit(
        act(SUBMIT_TEXT_ACTION, "composer", { text: "abcdef", key: KEY }),
        opts({ maxTextChars: 5 })
      )
    ).toMatchObject({ ok: false });
  });

  it("form values are rebuilt from DECLARED fields only; unknown, missing, mistyped and out-of-range are refused with fixed codes", () => {
    const o = opts();
    const form = (values: unknown) =>
      acceptChatSubmit(act(SUBMIT_FORM_ACTION, "form", { values, key: newSubmitKey() }), o);
    const good = form({ reason: "disk full", count: "3", urgent: true, env: "prod" });
    expect(good).toMatchObject({
      ok: true,
      submission: {
        kind: "form",
        values: { reason: "disk full", count: 3, urgent: true, env: "prod" },
      },
    });
    expect(form({ reason: "r", admin: true })).toEqual({
      ok: false,
      reason: "invalid",
      errors: { admin: "unknown" },
    });
    expect(form({})).toMatchObject({ ok: false, errors: { reason: "required" } });
    expect(form({ reason: "r", count: 99 })).toMatchObject({ errors: { count: "range" } });
    expect(form({ reason: "r", count: "NaN" })).toMatchObject({ errors: { count: "type" } });
    expect(form({ reason: "r", env: "staging" })).toMatchObject({ errors: { env: "option" } });
    expect(form({ reason: "x".repeat(51) })).toMatchObject({ errors: { reason: "too-long" } });
    expect(form({ reason: {} })).toMatchObject({ errors: { reason: "type" } });
    expect(form([])).toMatchObject({ ok: false });
    const hostile = form(JSON.parse('{"reason":"r","__proto__":{"isAdmin":true}}'));
    expect(hostile.ok).toBe(false);
    expect(!hostile.ok && Object.keys(hostile.errors ?? {})).toEqual(["__proto__"]);
    // an unchecked box is false, not missing
    expect(form({ reason: "r" })).toMatchObject({
      ok: true,
      submission: { values: { reason: "r", urgent: false } },
    });
    // the result is a plain object with only declared names
    if (good.ok && good.submission.kind === "form")
      expect(Object.keys(good.submission.values).sort()).toEqual([
        "count",
        "env",
        "reason",
        "urgent",
      ]);
  });

  it("a select value must be one of the declared options", () => {
    const o = opts();
    const sel = (value: unknown) =>
      acceptChatSubmit(act(SELECT_ACTION, "pick", { value, key: newSubmitKey() }), o);
    expect(sel("a")).toMatchObject({ ok: true, submission: { kind: "select", value: "a" } });
    expect(sel("c")).toEqual({ ok: false, reason: "invalid", errors: { value: "option" } });
    expect(sel(["a"])).toMatchObject({ ok: false });
    expect(sel("constructor")).toMatchObject({ ok: false });
  });

  it("EDIT_TURN: only when the widget is editable AND the host's policy allows that turn; it is a NEW submission, never a mutation", () => {
    const o = opts();
    const edit = (widget: string, turn: unknown, over: Partial<Parameters<typeof opts>[0]> = {}) =>
      acceptChatSubmit(
        act(EDIT_TURN_ACTION, widget, { turn, text: "better question", key: newSubmitKey() }),
        { ...o, ...over }
      );
    expect(edit("chat", 1)).toMatchObject({
      ok: true,
      submission: { kind: "edit", turn: 1, text: "better question" },
    });
    expect(edit("chat", 2)).toEqual({ ok: false, reason: "edit-not-allowed" }); // not the user's turn
    expect(edit("fixedchat", 1)).toEqual({ ok: false, reason: "edit-not-allowed" }); // the node did not offer editing
    expect(edit("chat", 1, { canEdit: undefined })).toEqual({
      ok: false,
      reason: "edit-not-allowed",
    }); // no policy: fail closed
    expect(
      edit("chat", 1, {
        canEdit: () => {
          throw new Error("db down");
        },
      })
    ).toEqual({ ok: false, reason: "edit-not-allowed" });
    expect(edit("chat", 1.5)).toMatchObject({ ok: false, reason: "invalid" });
    expect(edit("chat", 0)).toMatchObject({ ok: false, reason: "invalid" });
    expect(edit("chat", "1")).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("LOAD_OLDER is a read: needs a fresh view and a well-formed cursor, no key, nothing claimed", () => {
    const o = opts();
    expect(acceptChatSubmit(act(LOAD_OLDER_ACTION, "chat", { cursor: "0.12" }), o)).toMatchObject({
      ok: true,
      submission: { kind: "older", cursor: "0.12" },
    });
    expect(acceptChatSubmit(act(LOAD_OLDER_ACTION, "chat", { cursor: "0.12" }), o).ok).toBe(true); // repeatable
    expect(acceptChatSubmit(act(LOAD_OLDER_ACTION, "chat", { cursor: "../../x" }), o)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(o.ledger.size).toBe(0);
  });

  it("CHAT_REF_OPEN hands hasRef the principal and the widget id, not just the entry and ref", () => {
    const seen: unknown[][] = [];
    const o = opts({
      hasRef: (...a: unknown[]) => {
        seen.push(a);
        return true;
      },
    });
    const payload = { entryId: "t1.assistant", refId: "a1", n: 1 };
    expect(acceptChatSubmit(act(CHAT_REF_OPEN_ACTION, "chat", payload), o).ok).toBe(true);
    expect(seen).toEqual([["t1.assistant", "a1", "t/alice", { widgetId: "chat" }]]);
  });

  it("CHAT_REF_OPEN is a read matched against what the host served: shape, a served ref, a fresh view, no key, nothing claimed, browser-side", async () => {
    const hasRef = (e: string, r: string) => e === "t1.assistant" && r === "a1";
    const o = opts({ hasRef });
    const open = (payload: unknown, widget = "chat") =>
      acceptChatSubmit(act(CHAT_REF_OPEN_ACTION, widget, payload), o);
    expect(open({ entryId: "t1.assistant", refId: "a1", n: 1 })).toMatchObject({
      ok: true,
      submission: { kind: "ref", entryId: "t1.assistant", refId: "a1", n: 1 },
    });
    // a ref the host did not serve (another entry, another id): refused, whatever its shape
    expect(open({ entryId: "t1.assistant", refId: "zz", n: 1 })).toEqual({
      ok: false,
      reason: "ref-not-allowed",
    });
    expect(open({ entryId: "t2.assistant", refId: "a1", n: 1 })).toEqual({
      ok: false,
      reason: "ref-not-allowed",
    });
    // malformed payloads
    for (const bad of [
      { entryId: "t1 assistant", refId: "a1", n: 1 },
      { entryId: "t1.assistant", refId: "a1", n: 0 },
      { entryId: "t1.assistant", refId: "a1", n: 65 },
      { entryId: "t1.assistant", refId: "a1", n: 1.5 },
      { entryId: "t1.assistant", refId: "a1", n: "1" },
      { entryId: "t1.assistant", refId: "a1" },
    ])
      expect(open(bad)).toEqual({ ok: false, reason: "invalid" });
    // only a Chat may open one; the view must be fresh
    expect(open({ entryId: "t1.assistant", refId: "a1", n: 1 }, "composer").ok).toBe(false);
    expect(
      acceptChatSubmit(
        act(
          CHAT_REF_OPEN_ACTION,
          "chat",
          { entryId: "t1.assistant", refId: "a1", n: 1 },
          { viewedVersion: stamp({ versionHash: "sha256:v1" }) }
        ),
        o
      )
    ).toMatchObject({ ok: false, reason: "stale" });
    // a host that serves no refs (no hasRef), or whose hasRef throws, refuses everything
    const payload = { entryId: "t1.assistant", refId: "a1", n: 1 };
    expect(acceptChatSubmit(act(CHAT_REF_OPEN_ACTION, "chat", payload), opts())).toEqual({
      ok: false,
      reason: "ref-not-allowed",
    });
    expect(
      acceptChatSubmit(
        act(CHAT_REF_OPEN_ACTION, "chat", payload),
        opts({
          hasRef: () => {
            throw new Error("x");
          },
        })
      )
    ).toEqual({ ok: false, reason: "ref-not-allowed" });
    expect(o.ledger.size).toBe(0);
    const wb = createWriteBack({
      ...opts({ hasRef }),
      routes: { chat: conversationTarget(vi.fn()) },
    });
    expect(
      await wb.handle(act(CHAT_REF_OPEN_ACTION, "chat", payload), {
        principal: "t/alice",
        current: head,
      })
    ).toEqual({
      ok: false,
      reason: "browser-side",
    });
  });

  it("LOAD_REASONING is a read like LOAD_OLDER: a fresh view and a well-formed cursor, no key, nothing claimed, browser-side", async () => {
    const o = opts();
    expect(
      acceptChatSubmit(act(LOAD_REASONING_ACTION, "chat", { cursor: "0.12" }), o)
    ).toMatchObject({
      ok: true,
      submission: { kind: "reasoning", cursor: "0.12" },
    });
    expect(acceptChatSubmit(act(LOAD_REASONING_ACTION, "chat", { cursor: "x/../y" }), o)).toEqual({
      ok: false,
      reason: "invalid",
    });
    // only a Chat may ask
    expect(acceptChatSubmit(act(LOAD_REASONING_ACTION, "composer", { cursor: "0.12" }), o).ok).toBe(
      false
    );
    expect(o.ledger.size).toBe(0);
    const wb = createWriteBack({ ...opts(), routes: { chat: conversationTarget(vi.fn()) } });
    expect(
      await wb.handle(act(LOAD_REASONING_ACTION, "chat", { cursor: "0.12" }), {
        principal: "t/alice",
        current: head,
      })
    ).toEqual({
      ok: false,
      reason: "browser-side",
    });
  });

  it("a transcript that MOVED is not stale for a chat widget (no bindingSeq), but a recomposed one is", () => {
    const a = act(
      EDIT_TURN_ACTION,
      "chat",
      { turn: 1, text: "t", key: KEY },
      { viewedVersion: stamp({ binding: { state: "ready", seq: 3 } }) }
    );
    expect(acceptChatSubmit(a, opts()).ok).toBe(true);
    const b = act(
      EDIT_TURN_ACTION,
      "chat",
      { turn: 1, text: "t", key: newSubmitKey() },
      { viewedVersion: stamp({ binding: { state: "ready", seq: 3 } }) }
    );
    expect(acceptChatSubmit(b, opts({ current: { ...head, bindingSeq: () => 9 } }))).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("is total: a hostile spec lookup or payload getter cannot throw out of it", () => {
    const o = opts({
      specOf: () => {
        throw new Error("boom");
      },
    });
    expect(
      acceptChatSubmit(act(SUBMIT_TEXT_ACTION, "composer", { text: "x", key: KEY }), o)
    ).toEqual({ ok: false, reason: "not-a-submit" });
  });
});

describe("keys", () => {
  it("newSubmitKey mints distinct, well-formed keys", () => {
    const keys = new Set(Array.from({ length: 200 }, newSubmitKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(isSubmitKey(k)).toBe(true);
  });
});

describe("createWriteBack and the targets", () => {
  const mk = (routes: Record<string, (s: never) => unknown>) =>
    createWriteBack({ ...opts(), routes: routes as never });
  const ctx = { principal: "t/alice", current: head };

  it("routes an accepted text submit to a conversation as a turn whose messageId IS the idempotency key", async () => {
    const sendTurn = vi.fn(async () => ({ messageId: "m" }));
    const wb = mk({ composer: conversationTarget(sendTurn) });
    const key = newSubmitKey();
    const r = await wb.handle(act(SUBMIT_TEXT_ACTION, "composer", { text: "hello", key }), ctx);
    expect(r).toMatchObject({ ok: true });
    expect(sendTurn).toHaveBeenCalledWith("hello", { messageId: key });
  });

  it("a duplicate submit reaches the target ONCE and the user is told it landed, not that it failed", async () => {
    const sendTurn = vi.fn(async () => undefined);
    const wb = mk({ composer: conversationTarget(sendTurn) });
    const a = act(SUBMIT_TEXT_ACTION, "composer", { text: "hello", key: newSubmitKey() });
    expect(await wb.handle(a, ctx)).toMatchObject({ ok: true });
    expect(await wb.handle(a, ctx)).toEqual({ ok: true, reason: "duplicate" });
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });

  it("a failing write releases the key (the retry is accepted) and reports no error text", async () => {
    let fail = true;
    const sendTurn = vi.fn(async () => {
      if (fail) throw new Error("ECONNREFUSED db.internal:5432 password=hunter2");
    });
    const wb = mk({ composer: conversationTarget(sendTurn) });
    const a = act(SUBMIT_TEXT_ACTION, "composer", { text: "hello", key: newSubmitKey() });
    const first = await wb.handle(a, ctx);
    expect(first).toEqual({ ok: false, reason: "failed" });
    expect(JSON.stringify(first)).not.toContain("hunter2");
    fail = false;
    expect(await wb.handle(a, ctx)).toMatchObject({ ok: true });
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it("an edit becomes a NEW turn through the same target, or goes to the host's own fork/re-ask handler", async () => {
    const sendTurn = vi.fn(async () => undefined);
    const edit = vi.fn(async () => undefined);
    const plain = mk({ chat: conversationTarget(sendTurn) });
    const key = newSubmitKey();
    await plain.handle(act(EDIT_TURN_ACTION, "chat", { turn: 1, text: "revised", key }), ctx);
    expect(sendTurn).toHaveBeenCalledWith("revised", { messageId: key });
    const forking = mk({ chat: conversationTarget(sendTurn, { edit }) });
    await forking.handle(
      act(EDIT_TURN_ACTION, "chat", { turn: 1, text: "branch", key: newSubmitKey() }),
      ctx
    );
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "edit", turn: 1, text: "branch" })
    );
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });

  it("forms and selections resume a gate; selections and text set params; a widget with no route claims nothing", async () => {
    const resume = vi.fn(async () => undefined);
    const setParams = vi.fn();
    const o = opts();
    const wb = createWriteBack({
      ...o,
      routes: {
        form: resumeTarget(resume),
        pick: paramsTarget(setParams, "region"),
        composer: resumeTarget(resume),
      },
    });
    const key = newSubmitKey();
    await wb.handle(act(SUBMIT_FORM_ACTION, "form", { values: { reason: "r" }, key }), ctx);
    expect(resume).toHaveBeenCalledWith({ reason: "r", urgent: false }, { idempotencyKey: key });
    await wb.handle(act(SELECT_ACTION, "pick", { value: "b", key: newSubmitKey() }), ctx);
    expect(setParams).toHaveBeenCalledWith({ region: "b" });
    await wb.handle(act(SUBMIT_TEXT_ACTION, "composer", { text: "yes", key: newSubmitKey() }), ctx);
    expect(resume).toHaveBeenLastCalledWith({ text: "yes" }, expect.anything());
    const noRoute = createWriteBack({ ...o, ledger: new SubmitLedger(), routes: {} });
    const a = act(SELECT_ACTION, "pick", { value: "a", key: newSubmitKey() });
    expect(await noRoute.handle(a, ctx)).toEqual({ ok: false, reason: "no-route" });
    expect(await noRoute.handle(a, ctx)).toEqual({ ok: false, reason: "no-route" }); // the key was given back
  });

  it("a refused action reaches NO target", async () => {
    const sendTurn = vi.fn();
    const wb = mk({ composer: conversationTarget(sendTurn) });
    const stale = act(
      SUBMIT_TEXT_ACTION,
      "composer",
      { text: "x", key: newSubmitKey() },
      { viewedVersion: stamp({ versionHash: "sha256:old" }) }
    );
    expect(await wb.handle(stale, ctx)).toEqual({ ok: false, reason: "stale" });
    expect(
      await wb.handle(act(SUBMIT_TEXT_ACTION, "composer", { text: "  ", key: newSubmitKey() }), ctx)
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("fix round 1: host-side guards", () => {
  const ctx = { principal: "t/alice", current: head };
  it("a repeat while the first write is IN FLIGHT is told to wait, never that it landed; if the first fails, the retry is accepted", async () => {
    let release: (v?: unknown) => void = () => {};
    let calls = 0;
    const route = () => {
      calls++;
      return calls === 1
        ? new Promise((_r, rej) => {
            release = rej;
          })
        : undefined;
    };
    const wb = createWriteBack({ ...opts(), routes: { composer: route } });
    const a = act(SUBMIT_TEXT_ACTION, "composer", { text: "x", key: newSubmitKey() });
    const first = wb.handle(a, ctx);
    expect(await wb.handle(a, ctx)).toEqual({ ok: false, reason: "pending" });
    release(new Error("boom"));
    expect(await first).toEqual({ ok: false, reason: "failed" });
    expect(await wb.handle(a, ctx)).toMatchObject({ ok: true }); // the failure released the key
    expect(await wb.handle(a, ctx)).toEqual({ ok: true, reason: "duplicate" }); // now it really landed
  });

  it("LOAD_OLDER routed to a conversation target is refused with a reason, not a TypeError", async () => {
    const wb = createWriteBack({ ...opts(), routes: { chat: conversationTarget(vi.fn()) } });
    expect(await wb.handle(act(LOAD_OLDER_ACTION, "chat", { cursor: "0.12" }), ctx)).toEqual({
      ok: false,
      reason: "browser-side",
    });
  });

  it("canEdit is told which widget the edit came from", () => {
    const seen: unknown[] = [];
    acceptChatSubmit(
      act(EDIT_TURN_ACTION, "chat", { turn: 1, text: "t", key: newSubmitKey() }),
      opts({
        canEdit: (...a: unknown[]) => {
          seen.push(a);
          return true;
        },
      })
    );
    expect(seen).toEqual([[1, "t/alice", { widgetId: "chat" }]]);
  });

  it("a single-line form field is ONE line: CR / U+2028 become newlines in the sanitiser and are flattened after it", () => {
    const one = [{ name: "title", label: "Title", type: "text" as const }];
    const r = acceptChatSubmit(
      act(SUBMIT_FORM_ACTION, "form", {
        values: { reason: "r", title: "a\r\nb\u2028c\u2029d\ne" },
        key: newSubmitKey(),
      }),
      opts({
        specOf: (id: string) =>
          id === "form"
            ? ({ kind: "FormInput", fields: [...FIELDS, ...one] } as InputSpec)
            : SPECS[id],
      })
    );
    expect(r.ok && r.submission.kind === "form" && r.submission.values.title).toBe("a b c d e");
  });
});

describe("SELECT_MANY", () => {
  const published = new Set(["a", "b", "c"]);
  const accept = (payload: unknown, over: Record<string, unknown> = {}) =>
    acceptChatSubmit(
      act(SELECT_MANY_ACTION, "scope", payload),
      opts({
        specOf: (id: string): InputSpec | undefined =>
          id === "scope" ? { kind: "MultiSelectInput", maxSelected: 2 } : undefined,
        optionsOf: (id: string) => (id === "scope" ? published : undefined),
        ...over,
      })
    );

  it("accepts a set of published values, and the empty set", () => {
    const r = accept({ values: ["b", "a"], key: KEY });
    expect(r.ok && r.submission).toEqual({
      kind: "select-many",
      widgetId: "scope",
      key: KEY,
      values: ["b", "a"],
    });
    expect(accept({ values: [], key: KEY }).ok).toBe(true);
  });

  it("refuses a value the host did not publish, a repeat, too many, and a non-list", () => {
    const invalid = (values: "option" | "range" | "type") => ({
      ok: false,
      reason: "invalid",
      errors: { values },
    });
    expect(accept({ values: ["z"], key: KEY })).toEqual(invalid("option"));
    expect(accept({ values: ["a", "a"], key: KEY })).toEqual(invalid("option"));
    expect(accept({ values: ["a", "b", "c"], key: KEY })).toEqual(invalid("range"));
    expect(accept({ values: "a", key: KEY })).toEqual(invalid("type"));
    expect(accept({ values: [1], key: KEY })).toEqual(invalid("type"));
  });

  it("reads the list by index: an own Symbol.iterator cannot smuggle in more than maxSelected", () => {
    const sneaky: string[] = [];
    Object.defineProperty(sneaky, Symbol.iterator, {
      value: function* () {
        yield* ["a", "b", "c"];
      },
    });
    const r = accept({ values: sneaky, key: KEY });
    // length is 0, so the index loop sees nothing: an empty choice, never the three yielded values
    expect(r.ok && r.submission).toEqual({
      kind: "select-many",
      widgetId: "scope",
      key: KEY,
      values: [],
    });
  });

  it("refuses everything when the host serves no options (absent, undefined, or throwing)", () => {
    expect(accept({ values: [], key: KEY }, { optionsOf: undefined }).ok).toBe(false);
    expect(accept({ values: [], key: KEY }, { optionsOf: () => undefined }).ok).toBe(false);
    expect(
      accept(
        { values: [], key: KEY },
        {
          optionsOf: () => {
            throw new Error("x");
          },
        }
      ).ok
    ).toBe(false);
  });

  it("refuses a bad key, the wrong kind, a stale view, and never burns a key on a refusal", () => {
    expect(accept({ values: ["a"], key: "short" })).toEqual({ ok: false, reason: "bad-key" });
    expect(accept({ values: ["a"], key: KEY }, { specOf: () => SPECS.pick })).toEqual({
      ok: false,
      reason: "wrong-input",
    });
    const stale = act(
      SELECT_MANY_ACTION,
      "scope",
      { values: ["a"], key: KEY },
      { viewedVersion: stamp({ versionHash: "sha256:v1", blueprintId: "e@sha256:v1" }) }
    );
    const ledger = new SubmitLedger();
    const o = opts({
      specOf: () => ({ kind: "MultiSelectInput", maxSelected: 2 }),
      optionsOf: () => published,
      ledger,
    });
    expect(acceptChatSubmit(stale, o)).toEqual({ ok: false, reason: "stale" });
    expect(accept({ values: ["z"], key: KEY }, { ledger }).ok).toBe(false);
    expect(accept({ values: ["a"], key: KEY }, { ledger }).ok).toBe(true);
  });

  it("resumeTarget hands a gate { values }", async () => {
    const resume = vi.fn();
    await resumeTarget(resume)({ kind: "select-many", widgetId: "w", key: KEY, values: ["a"] });
    expect(resume).toHaveBeenCalledWith({ values: ["a"] }, { idempotencyKey: KEY });
  });
});
