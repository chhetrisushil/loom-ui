import { EventEmitter } from "node:events";
import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { blueprint$, customWidget$, stack } from "@loom/blueprint-runtime";
import type { Blueprint, Widget } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { inert } from "./inert";
import {
  type InteractiveOptions,
  createKeyDecoder,
  decodeKeys,
  interactiveTerminal,
} from "./interactive";

// The controls footer is the one place a VIEWER's keystrokes and the HOST's words reach the terminal
// raw. These tests are the probes: each one fails on the code before its fix.

const bind = (h: string) => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(h),
  status: { path: hydrationStatusPath(h) },
});
const approval = customWidget$({
  kind: "ApprovalCard",
  id: "ok",
  title: "Deploy?",
  binding: bind("h-ok"),
});
const text = customWidget$({
  kind: "TextInput",
  id: "txt",
  title: "Ask",
  props: { label: "Question" },
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
const view = (id: string, ...children: Widget[]): Blueprint =>
  blueprint$({
    id,
    title: "Board",
    projections: [HYDRATION_PROJECTION_ID],
    layout: stack({ children }),
  });
const newStore = () => new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp" });

function rig(bp: Blueprint, extra: Partial<InteractiveOptions> = {}, hold?: Promise<void>) {
  const store = newStore();
  store.setValue("h-ok", { pending: true }, { state: "ready" });
  const writes: string[] = [];
  const actions: Array<Record<string, unknown>> = [];
  const term = interactiveTerminal(bp, {
    store,
    input: new EventEmitter(),
    output: { write: (s) => writes.push(s) },
    onAction: async (a) => {
      actions.push(a as never);
      await hold;
    },
    ...extra,
  });
  return { store, term, writes, actions };
}
const types = (a: Array<Record<string, unknown>>) => a.map((x) => x.type);

describe("a paste can never approve or submit", () => {
  it("a newline then a tab then `y` inside one pasted chunk neither submits-and-approves nor approves", async () => {
    const { term, actions } = rig(view("e@v1", text, approval));
    await term.send("\r"); // open the draft
    await term.send("see log:\n\tyes it failed");
    expect(types(actions)).not.toContain("APPROVE");
    expect(actions).toEqual([]); // a submit is consent: not on a multi-key chunk
  });

  it("an OSC string and a tab then `y` in one chunk never reach the approval", async () => {
    const { term, actions } = rig(view("e@v1", text, approval));
    await term.send("\r");
    await term.send("hello \x1b]0;x\x07\ty");
    expect(actions).toEqual([]);
    expect(term.frame()).not.toContain("\x1b");
    // an ESC mid-chunk ends the draft; the rest of the chunk is dropped, never navigated
    await term.send("hi\x1b\ty");
    expect(actions).toEqual([]);
  });

  it("a bracketed paste is text only: newlines stay in the draft, nothing navigates or answers", async () => {
    const { term, actions, writes } = rig(view("e@v1", text, approval));
    expect(writes.join("")).toContain("\x1b[?2004h");
    await term.send("\r");
    await term.send("\x1b[200~see log:\n\tyes it failed\x1b[201~");
    expect(actions).toEqual([]);
    expect(term.frame()).toContain("see log:\n yes it failed");
    expect(term.focused()).toBe("txt");
    // a paste split across chunks is still one paste
    await term.send("\x1b[200~ and\n");
    await term.send("y\x1b[201~");
    expect(actions).toEqual([]);
    expect(term.frame()).toContain("and\ny");
    // with no draft open a paste is nothing at all
    await term.send("\x1b");
    await term.send("\t");
    expect(term.focused()).toBe("ok");
    await term.send("\x1b[200~y\x1b[201~");
    expect(actions).toEqual([]);
    term.stop();
    expect(writes.join("")).toContain("\x1b[?2004l");
  });

  it("y alone still approves, but not behind another key", async () => {
    const { term, actions } = rig(view("e@v1", approval));
    await term.send("\ty");
    expect(actions).toEqual([]);
    await term.send("y");
    expect(types(actions)).toEqual(["APPROVE"]);
  });
});

describe("the whole frame is inert, footer included", () => {
  it("strips controls from i18n words, hint, focus mark and the draft echo", async () => {
    const { term, writes } = rig(view("e@v1", text, approval), {
      i18n: {
        messages: {
          "lu.approval.approve": "Yes\x1b[2J",
          "lu.approval.reject": "No\x1b]52;c;cGF5\x07",
        },
      },
      labels: { hint: "keys\x1b]0;t\x07", focus: ">\x9b" },
    });
    await term.send("\r");
    await term.press({ name: "char", char: "\x1b]52;c;cGF5\x07" }); // not one printable code point: refused
    await term.press({ name: "char", char: "a\x1b" });
    await term.press({ name: "char", char: "‮" });
    await term.send("ab​c");
    const frame = term.frame();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
    expect(frame).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​‮]/);
    expect(frame).toContain("Yes[2J");
    expect(frame).toContain("Question: abc▏");
    expect(frame).not.toContain("52;c;cGF5\x07");
    expect(writes.join("")).not.toContain("\x1b]");
    expect(writes.join("")).not.toContain("\x1b[2J" + "Yes");
  });
});

describe("one stripping set", () => {
  const INVISIBLE = ["​", "‎", "‏", "؜", "⁠", "⁥", "⁦", "⁩", "­", "\u{e0041}", " ", " ", "‪"];
  it("inert and key decoding drop every code point core's sanitizeChatText drops", () => {
    for (const c of INVISIBLE) {
      expect(inert(`a${c}b`), JSON.stringify(c)).toBe("ab");
      expect(
        decodeKeys(`a${c}b`).map((k) => k.char),
        JSON.stringify(c)
      ).toEqual(["a", "b"]);
    }
    expect(inert("a\nb\tc\rd")).toBe("a\nbcd");
  });
});

describe("a key is stamped, and judged, on the frame it was pressed on", () => {
  it("a consent key queued behind an in-flight action is refused once a new version lands", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const v1 = view("e@v1", select, approval);
    const { term, actions } = rig(v1, {}, hold);
    await term.send("\r");
    const inFlight = term.send("1"); // SELECT is now awaiting the host
    await Promise.resolve();
    const tabbed = term.send("\t");
    const answered = term.send("y"); // pressed on v1, queued behind the SELECT
    term.update(view("e@v2", select, approval));
    release();
    await Promise.all([inFlight, tabbed, answered]);
    expect(types(actions)).toEqual(["SELECT"]);
    expect((actions[0]?.viewedVersion as { blueprintId: string }).blueprintId).toBe("e@v1");
    expect(term.frame()).toContain("The view changed.");
    // pressed again on the new frame it is a fresh, valid answer stamped v2
    await term.send("y");
    expect(types(actions)).toEqual(["SELECT", "APPROVE"]);
    expect((actions[1]?.viewedVersion as { blueprintId: string }).blueprintId).toBe("e@v2");
  });
});

describe("paste mode always ends, and a lone key is alone", () => {
  const END = "\x1b[201~";
  it("an end marker split at every point still ends the paste", async () => {
    for (let n = 1; n < END.length; n++) {
      const { term, actions } = rig(view("e@v1", text, approval));
      await term.send("\r");
      await term.send(`\x1b[200~hi${END.slice(0, n)}`);
      await term.send(END.slice(n));
      expect(term.frame()).toContain("hi");
      await term.send("\x1b"); // back to nav: keys are live again
      await term.send("\t");
      expect(term.focused()).toBe("ok");
      expect(actions).toEqual([]);
      term.stop();
    }
  });
  it("decoder: split marker yields one paste; an unclosed paste then Ctrl-C yields the interrupt", () => {
    const d = createKeyDecoder();
    expect(d("\x1b[200~hi\x1b[20")).toEqual([]);
    expect(d("1~")).toEqual([{ name: "paste", text: "hi" }]);
    expect(d("\x1b[200~abc")).toEqual([]);
    expect(d("\x03")).toEqual([{ name: "interrupt" }]);
    expect(d("y")).toEqual([{ name: "char", char: "y" }]);
  });
  it("an unclosed paste cannot swallow Ctrl-C or approve", async () => {
    let interrupted = 0;
    const { term, actions } = rig(view("e@v1", approval), { onInterrupt: () => interrupted++ });
    await term.send("\x1b[200~abc");
    await term.send("y");
    await term.send("\x03");
    expect(interrupted).toBe(1);
    expect(actions).toEqual([]);
    await term.send("y");
    expect(types(actions)).toEqual(["APPROVE"]);
  });
  it("an oversize paste is discarded and swallowed to its end, never typed", () => {
    const d = createKeyDecoder();
    expect(d(`\x1b[200~${"a".repeat((1 << 20) + 1)}`)).toEqual([]);
    expect(d("y\ty")).toEqual([]);
    expect(d(`${END}y`)).toEqual([{ name: "char", char: "y" }]);
  });
  describe("a stalled paste's remainder is drained, never typed", () => {
    const stalled = () => {
      const clock = { t: 0 };
      const d = createKeyDecoder({ now: () => clock.t, pasteIdleMs: 2000 });
      expect(d("\x1b[200~abc")).toEqual([]);
      clock.t = 1999;
      expect(d("def")).toEqual([]); // still within the idle bound: pasted text
      clock.t = 1999 + 2001; // idle longer than the bound
      return { d, clock };
    };
    it("the remainder and the end marker (even split) yield no keys, then typing resumes", () => {
      const { d, clock } = stalled();
      expect(d("rest\ty\n")).toEqual([]);
      clock.t += 100;
      expect(d("more\x1b[20")).toEqual([]);
      clock.t += 100;
      expect(d("1~")).toEqual([]);
      expect(d("y")).toEqual([{ name: "char", char: "y" }]);
    });
    it("Ctrl-C leaves the drain and is delivered as an interrupt", () => {
      const { d } = stalled();
      expect(d("junk\x03y")).toEqual([{ name: "interrupt" }, { name: "char", char: "y" }]);
      expect(d("y")).toEqual([{ name: "char", char: "y" }]);
    });
    it("a second idle period with no input resumes normal decoding", () => {
      const { d, clock } = stalled();
      expect(d("tail")).toEqual([]);
      clock.t += 2001;
      expect(d("y")).toEqual([{ name: "char", char: "y" }]);
    });
  });
  it("a dropped sequence or non-printable beside `y` disqualifies it", async () => {
    for (const chunk of ["\x1b[Cy", "\x1b]52;c;AAAA\x07y", "y\x1b[C", "‮y", "\x00y"]) {
      const { term, actions } = rig(view("e@v1", approval));
      await term.send(chunk);
      expect(actions).toEqual([]);
      term.stop();
    }
    const { term, actions } = rig(view("e@v1", approval));
    await term.send("y");
    expect(types(actions)).toEqual(["APPROVE"]);
  });
});

describe("confirmConsent asks twice", () => {
  it("the first y arms, the same key in a later chunk acts, another key disarms", async () => {
    const { term, actions } = rig(view("e@v1", approval), { confirmConsent: true });
    await term.send("y");
    expect(actions).toEqual([]);
    expect(term.frame()).toContain("y ×2");
    await term.send("n"); // a different key re-arms for n, does not act
    expect(actions).toEqual([]);
    await term.send("\t"); // disarm
    await term.send("y");
    expect(actions).toEqual([]);
    await term.send("y");
    expect(types(actions)).toEqual(["APPROVE"]);
  });
  it("a multi-key chunk never confirms", async () => {
    const { term, actions } = rig(view("e@v1", approval), { confirmConsent: true });
    await term.send("y");
    await term.send("yy");
    expect(actions).toEqual([]);
  });
});
