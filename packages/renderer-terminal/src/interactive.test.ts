import { EventEmitter } from "node:events";
import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { SELECT_ACTION, SUBMIT_TEXT_ACTION, isSubmitKey } from "@loom-ui/core/chat";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, customWidget$, stack } from "@loom/blueprint-runtime";
import type { Blueprint, Widget } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type PaintStats,
  type TerminalInput,
  decodeKeys,
  diffFrames,
  interactiveTerminal,
  paintPatches,
} from "./interactive";
import { renderExperience } from "./status";

const bind = (h: string) => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(h),
  status: { path: hydrationStatusPath(h) },
});
const metric = (id: string) => MetricCard({ id, title: id, binding: bind(`h-${id}`) });
const approval = customWidget$({
  kind: "ApprovalCard",
  id: "ok",
  title: "Deploy?",
  binding: bind("h-ok"),
});
const select = customWidget$({
  kind: "SelectInput",
  id: "sel",
  title: "Region",
  props: {
    label: "Region",
    options: [
      { value: "eu", label: "Europe" },
      { value: "us", label: "United States" },
    ],
  },
});
const text = customWidget$({
  kind: "TextInput",
  id: "txt",
  title: "Ask",
  props: { label: "Question" },
});
const view = (...children: Widget[]): Blueprint =>
  blueprint$({
    id: "exp@v1",
    title: "Board",
    projections: [HYDRATION_PROJECTION_ID],
    layout: stack({ children }),
  });
const newStore = () => new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp" });

function rig(bp: Blueprint, onAction?: (a: never) => unknown) {
  const store = newStore();
  const writes: string[] = [];
  const paints: PaintStats[] = [];
  const actions: Array<Record<string, unknown>> = [];
  const term = interactiveTerminal(bp, {
    store,
    output: { write: (s) => writes.push(s) },
    onPaint: (p) => paints.push(p),
    onAction: (a) => {
      actions.push(a as never);
      return onAction?.(a as never);
    },
  });
  return { store, term, writes, paints, actions };
}

describe("decodeKeys", () => {
  it("names the keys a prompt needs and drops everything else whole", () => {
    expect(decodeKeys("\t\x1b[Z\x1b[A\x1b[B\r\x7f\x1b\x03").map((k) => k.name)).toEqual([
      "tab",
      "shift-tab",
      "up",
      "down",
      "enter",
      "backspace",
      "escape",
      "interrupt",
    ]);
    // Arrows left/right, function keys and mouse reports are not input: their bytes never become characters.
    expect(decodeKeys("\x1b[C\x1b[1;5D\x1b[15~a")).toEqual([{ name: "char", char: "a" }]);
    // A paste is a run of characters; control characters and bidi overrides are not typed text.
    expect(decodeKeys("h‮i\u0001!").map((k) => k.char)).toEqual(["h", "i", "!"]);
    expect(decodeKeys("é😀").map((k) => k.char)).toEqual(["é", "😀"]);
  });
});

describe("incremental paint", () => {
  it("diffFrames names only the lines that differ, including appended and removed ones", () => {
    expect(diffFrames(["a", "b", "c"], ["a", "B", "c"])).toEqual([{ line: 1, text: "B" }]);
    expect(diffFrames(["a"], ["a", "x", "y"])).toEqual([
      { line: 1, text: "x" },
      { line: 2, text: "y" },
    ]);
    expect(diffFrames(["a", "b"], ["a"])).toEqual([{ line: 1, text: undefined }]);
    expect(diffFrames(["a"], ["a"])).toEqual([]);
    expect(paintPatches([], 1)).toBe("");
    expect(paintPatches([{ line: 1, text: "B" }], 3)).toBe("\x1b[2;1H\x1b[2KB\x1b[4;1H");
  });

  it("paints the whole frame once, then rewrites only the line a change touches", () => {
    const { store, writes, paints } = rig(view(metric("a"), metric("b")));
    expect(paints).toEqual(
      [{ mode: "full", changedLines: 7, totalLines: 7 }].map((p) =>
        expect.objectContaining({ mode: p.mode })
      )
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("\x1b[2J");
    store.setValue("h-a", 7, { state: "ready" });
    const patch = paints.at(-1);
    expect(patch).toMatchObject({ mode: "patch", changedLines: 1 });
    expect(writes).toHaveLength(2);
    // One cursor-addressed line rewrite, not a repaint.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape sequences is the point
    expect(writes[1]?.match(/\x1b\[\d+;1H\x1b\[2K/g)).toHaveLength(1);
    expect(writes[1]).toContain("a: 7");
    expect(writes[1]).not.toContain("b");
  });

  it("a change that leaves the frame as it was writes nothing", () => {
    const { store, writes, paints } = rig(view(metric("a")));
    store.setValue("h-a", 7, { state: "ready" });
    const n = writes.length;
    store.setValue("h-a", 7, { state: "ready" });
    expect(writes).toHaveLength(n);
    expect(paints.at(-1)?.mode).toBe("none");
  });

  it("update() lands a revised Blueprint by rewriting only what changed", () => {
    const { store, term, writes, paints } = rig(view(metric("a")));
    store.setValue("h-a", 7, { state: "ready" });
    const before = writes.length;
    term.update(view(metric("a"), metric("b")));
    expect(writes).toHaveLength(before + 1);
    expect(paints.at(-1)).toMatchObject({ mode: "patch" });
    expect((paints.at(-1) as PaintStats).changedLines).toBeLessThan(
      (paints.at(-1) as PaintStats).totalLines
    );
    expect(writes.at(-1)).toContain("b");
    expect(writes.at(-1)).not.toContain("a: 7");
    expect(term.frame()).toContain("a: 7");
  });
});

describe("the snapshot is untouched", () => {
  it("with no controls the frame IS renderExperience, byte for byte", () => {
    const store = newStore();
    store.setValue("h-a", 7, { state: "ready" });
    const bp = view(metric("a"), metric("b"));
    const term = interactiveTerminal(bp, { store });
    expect(term.frame()).toBe(renderExperience(bp, store));
    expect(term.controls()).toEqual([]);
  });
  it("with controls the snapshot is still the exact prefix of the frame", () => {
    const store = newStore();
    const bp = view(metric("a"), select, text);
    const term = interactiveTerminal(bp, { store });
    expect(term.frame().startsWith(renderExperience(bp, store))).toBe(true);
    expect(term.controls().map((c) => c.id)).toEqual(["sel", "txt"]);
  });
});

describe("focus and actions", () => {
  it("Tab and Shift-Tab move focus and wrap", async () => {
    const { term } = rig(view(select, text));
    expect(term.focused()).toBe("sel");
    await term.send("\t");
    expect(term.focused()).toBe("txt");
    await term.send("\t");
    expect(term.focused()).toBe("sel");
    await term.send("\x1b[Z");
    expect(term.focused()).toBe("txt");
    expect(term.frame()).toMatch(/▸ Question/);
  });

  it("an approval is acted on with y / n only, and emits the shared APPROVE / REJECT shape, stamped", async () => {
    const { store, term, actions } = rig(view(approval));
    expect(term.controls()).toEqual([]); // nothing pending: no controls, like the web
    store.setValue("h-ok", { pending: true }, { state: "ready" });
    expect(term.controls().map((c) => c.kind)).toEqual(["approval"]);
    await term.send("\r"); // Enter is NOT consent
    expect(actions).toEqual([]);
    await term.send("y");
    await term.send("n");
    expect(actions.map((a) => [a.type, a.widgetId, a.payload])).toEqual([
      ["APPROVE", "ok", { approved: true }],
      ["REJECT", "ok", { approved: false }],
    ]);
    expect(actions[0]?.viewedVersion).toMatchObject({ blueprintId: "exp@v1", experienceId: "exp" });
  });

  it("a select opens a list, picks by digit or arrows + Enter, and Escape backs out", async () => {
    const { term, actions } = rig(view(select));
    await term.send("\r");
    expect(term.frame()).toMatch(/› 1\) Europe/);
    await term.send("\x1b");
    expect(actions).toEqual([]);
    await term.send("\r2");
    expect(actions[0]).toMatchObject({
      type: SELECT_ACTION,
      widgetId: "sel",
      payload: { value: "us" },
    });
    expect(isSubmitKey((actions[0]?.payload as { key: string }).key)).toBe(true);
    await term.send("\r\x1b[B\r");
    expect((actions[1]?.payload as { value: string }).value).toBe("us");
    await term.send("\r9"); // no 9th option: nothing is sent
    expect(actions).toHaveLength(2);
  });

  it("text entry types, edits, submits once, and keeps the draft until the host says it arrived", async () => {
    let ok = false;
    const { term, actions } = rig(view(text), () => ({ ok }));
    await term.send("\r");
    await term.send("helo\x7flo!");
    expect(term.frame()).toContain("Question: hello!▏");
    await term.send("\r");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: SUBMIT_TEXT_ACTION,
      widgetId: "txt",
      payload: { text: "hello!" },
    });
    // The host refused: still editing, draft kept, a retry sends the same text again.
    expect(term.frame()).toContain("hello!▏");
    ok = true;
    await term.send("\r");
    expect(actions).toHaveLength(2);
    expect(term.frame()).toContain("Question: …");
  });

  it("an empty submission and an unavailable host send nothing / pretend nothing", async () => {
    const empty = rig(view(text));
    await empty.term.send("\r\r");
    expect(empty.actions).toEqual([]);
    expect(empty.term.frame()).toContain("Type a message first.");

    const store = newStore();
    const term = interactiveTerminal(view(text), { store });
    await term.send("\rhi\r");
    expect(term.frame()).toContain("Sending is not available here.");
  });

  it("a refusal or a throw is shown as a fixed sentence, never the host's text", async () => {
    const refused = rig(view(text), () => ({ ok: false, reason: "stale" }));
    await refused.term.send("\rhi\r");
    expect(refused.term.frame()).toContain("The view changed.");
    const threw = rig(view(text), () => {
      throw new Error("db password hunter2");
    });
    await threw.term.send("\rhi\r");
    expect(threw.term.frame()).toContain("Not sent. Try again.");
    expect(threw.term.frame()).not.toContain("hunter2");
  });

  it("a control character in what is typed or in a label never reaches the frame", async () => {
    const evil = customWidget$({ kind: "TextInput", id: "txt", props: { label: "Q\x1b[2Jx" } });
    const { term } = rig(view(evil));
    await term.send("\rab\x1b[2Jc");
    expect(term.frame()).not.toContain("\x1b");
  });
});

describe("injected streams", () => {
  const stream = () => {
    const ee = new EventEmitter();
    const raw: boolean[] = [];
    const input: TerminalInput = Object.assign(ee, {
      setRawMode: (r: boolean) => raw.push(r),
      resume: () => undefined,
    });
    return { ee, input, raw };
  };

  it("reads keys from the input, and stop() detaches it, the store and raw mode", async () => {
    const { ee, input, raw } = stream();
    const store = newStore();
    const writes: string[] = [];
    const actions: unknown[] = [];
    const term = interactiveTerminal(view(metric("a"), select), {
      store,
      input,
      output: { write: (s) => writes.push(s) },
      onAction: (a) => void actions.push(a),
    });
    expect(raw).toEqual([true]);
    ee.emit("data", Buffer.from("\r1"));
    await vi.waitFor(() => expect(actions).toHaveLength(1));
    term.stop();
    term.stop(); // idempotent
    expect(raw).toEqual([true, false]);
    expect(ee.listenerCount("data")).toBe(0);
    const n = writes.length;
    store.setValue("h-a", 9, { state: "ready" });
    expect(writes).toHaveLength(n);
  });

  it("Ctrl-C calls onInterrupt (default: stop)", async () => {
    const { ee, input } = stream();
    const onInterrupt = vi.fn();
    interactiveTerminal(view(select), { store: newStore(), input, onInterrupt });
    ee.emit("data", "\x03");
    await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledOnce());
    const def = stream();
    interactiveTerminal(view(select), { store: newStore(), input: def.input });
    def.ee.emit("data", "\x03");
    await vi.waitFor(() => expect(def.ee.listenerCount("data")).toBe(0));
  });

  it("keys sent back to back are handled in order, one at a time", async () => {
    const { term, actions } = rig(view(select, text));
    await Promise.all([
      term.send("\r"),
      term.send("1"),
      term.send("\t"),
      term.send("\r"),
      term.send("ok"),
      term.send("\r"),
    ]);
    expect(actions.map((a) => a.type)).toEqual([SELECT_ACTION, SUBMIT_TEXT_ACTION]);
  });
});
