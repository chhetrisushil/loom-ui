import {
  HYDRATION_VALUES_PREFIX,
  type LuI18n,
  type StampedAction,
  createSay,
  oneLineChatText,
  optionsProblem,
  viewedVersionOf,
} from "@loom-ui/core";
import type { ActionOutcome } from "@loom-ui/core/browser";
import {
  SELECT_ACTION,
  SUBMIT_TEXT_ACTION,
  newSubmitKey,
  stripUnsafeChars,
  validateSelectValue,
  validateTextValue,
} from "@loom-ui/core/chat-ui";
import type { HydrationStore } from "@loom-ui/hydration/client";
import type { Blueprint, Layout, Widget } from "@loom/blueprint-runtime";
import { inert } from "./inert";
import { type RenderExperienceOptions, renderExperience } from "./status";

// ── Interactive terminal ───────────────────────────────────────────────────────────────────────
// `renderExperience` is a snapshot: a string in, a string out, byte-for-byte stable. This module is
// the OTHER way to use the same renderer, and is strictly opt-in: it keeps the snapshot as the body
// of every frame and adds (a) a controls footer a viewer can move through and act on, and (b) an
// incremental paint that rewrites only the lines that changed. Input and output are injected
// (`TerminalInput` / `TerminalOutput`), so it runs the same under a TTY, a pipe or a test.

/** What the session reads keys from: a TTY's `process.stdin`, or any emitter of `data` chunks. */
export interface TerminalInput {
  on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  off?(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  removeListener?(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  /** A TTY's raw mode: set while the session is live so keys arrive unbuffered. Optional. */
  setRawMode?(raw: boolean): unknown;
  resume?(): unknown;
}

/** Where frames are painted: a TTY's `process.stdout`, or any sink with `write`. */
export interface TerminalOutput {
  write(chunk: string): unknown;
}

export type KeyName =
  | "tab"
  | "shift-tab"
  | "up"
  | "down"
  | "enter"
  | "escape"
  | "backspace"
  | "interrupt"
  | "paste"
  | "char";
export interface Key {
  readonly name: KeyName;
  /** The printable character, for `name: "char"`. */
  readonly char?: string;
  /** The pasted text, for `name: "paste"`: already inert, newlines normalised to `\n`. It is TEXT only, never a command. */
  readonly text?: string;
}

/** Bracketed paste: the terminal wraps a paste in these, so it can never be taken for typing. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Enable / disable bracketed paste mode. */
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
/** Most paste text one span keeps (a paste is a draft, not a file). */
const MAX_PASTE = 1 << 20;

const pasteText = (raw: string): string =>
  stripUnsafeChars(raw.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(/\t/g, " "));

/** One printable code point: what a `char` key may carry. Anything else is not typed text. */
export function isPrintableChar(ch: unknown): ch is string {
  if (typeof ch !== "string" || ch === "" || Array.from(ch).length !== 1) return false;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x2028 || cp === 0x2029) return false;
  return stripUnsafeChars(ch) === ch;
}

const NAMED: ReadonlyArray<readonly [string, KeyName]> = [
  ["\x1b[Z", "shift-tab"],
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\t", "tab"],
  ["\r\n", "enter"],
  ["\r", "enter"],
  ["\n", "enter"],
  ["\x7f", "backspace"],
  ["\b", "backspace"],
  ["\x03", "interrupt"],
];

/**
 * A decoder that remembers an unfinished bracketed paste across chunks. `decodeKeys` is the
 * stateless form (one chunk, a fresh decoder).
 */
export function createKeyDecoder(): (chunk: string) => Key[] {
  let pasting: string | undefined;
  return (chunk) => {
    const keys: Key[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (pasting !== undefined) {
        const end = chunk.indexOf(PASTE_END, i);
        const stop = end === -1 ? chunk.length : end;
        if (pasting.length < MAX_PASTE) pasting += chunk.slice(i, stop);
        if (end === -1) return keys;
        keys.push({ name: "paste", text: pasteText(pasting) });
        pasting = undefined;
        i = end + PASTE_END.length;
        continue;
      }
      const rest = chunk.slice(i);
      if (rest.startsWith(PASTE_START)) {
        pasting = "";
        i += PASTE_START.length;
        continue;
      }
      const hit = NAMED.find(([seq]) => rest.startsWith(seq));
      if (hit !== undefined) {
        keys.push({ name: hit[1] });
        i += hit[0].length;
        continue;
      }
      if (rest.startsWith("\x1b")) {
        // A control string (OSC/DCS/SOS/PM/APC) is dropped WHOLE, payload included; so is a CSI/SS3.
        const seq = CONTROL_STRING.exec(rest) ?? CSI.exec(rest) ?? SS3.exec(rest);
        if (seq !== null) {
          i += seq[0].length;
          continue;
        }
        keys.push({ name: "escape" });
        i += 1;
        continue;
      }
      const cp = rest.codePointAt(0) ?? 0;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      // Controls, bidi and invisible marks are never typed text (core's one unsafe set).
      if (isPrintableChar(ch)) keys.push({ name: "char", char: ch });
    }
    return keys;
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC begins the sequences being matched
const CONTROL_STRING = /^\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC begins the sequences being matched
const CSI = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC begins the sequences being matched
const SS3 = /^\x1bO[@-~]/;

/**
 * Split a chunk of terminal input into keys. Unknown escape sequences (arrows left/right, function
 * keys, mouse reports, OSC strings) are dropped whole rather than leaking their bytes in as
 * characters; a lone ESC is `escape`. Printable code points become `char` keys; a bracketed paste
 * (`ESC[200~ … ESC[201~`) is ONE `paste` key, text only.
 */
export function decodeKeys(chunk: string): Key[] {
  return createKeyDecoder()(chunk);
}

/** One changed line of a repaint. `text: undefined` = the line no longer exists. */
export interface LinePatch {
  /** 0-based line index within the frame. */
  readonly line: number;
  readonly text: string | undefined;
}

/** The lines that differ between two frames, in order. Equal frames diff to nothing. */
export function diffFrames(prev: readonly string[], next: readonly string[]): LinePatch[] {
  const out: LinePatch[] = [];
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n; i++) if (prev[i] !== next[i]) out.push({ line: i, text: next[i] });
  return out;
}

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const at = (line: number): string => `\x1b[${line + 1};1H`;

/** The escape sequences that apply `patches`, then park the cursor under the frame. */
export function paintPatches(patches: readonly LinePatch[], nextLength: number): string {
  if (patches.length === 0) return "";
  const body = patches.map((p) => `${at(p.line)}\x1b[2K${p.text ?? ""}`).join("");
  return `${body}${at(nextLength)}`;
}

/** The fixed words the controls footer uses beyond `LU_MESSAGES`: symbols, host-overridable. */
export interface InteractiveLabels {
  /** The key legend under the controls. Default: symbols only (no words to translate). */
  readonly hint?: string;
  /** The marker before the focused control. Default `▸`. */
  readonly focus?: string;
}

export interface InteractiveOptions extends RenderExperienceOptions {
  readonly store: HydrationStore;
  /**
   * Every `WidgetAction` a control emits, stamped with `viewedVersion` like the web's. It MAY return
   * (a promise of) an `ActionOutcome`; nothing returned is success, `ok: false` / a throw is failure.
   * No handler = "not available here": nothing is pretended to be sent.
   */
  readonly onAction?: (action: StampedAction) => unknown;
  readonly input?: TerminalInput;
  readonly output?: TerminalOutput;
  /** Called after each repaint with what changed (the incremental-render evidence). */
  readonly onPaint?: (stats: PaintStats) => void;
  /** Called on Ctrl-C. Default: `stop()`. */
  readonly onInterrupt?: () => void;
  readonly labels?: InteractiveLabels;
  /** The compile fingerprint stamped on every action (`viewedVersion.compile`). */
  readonly compile?: string;
}

export interface PaintStats {
  /** `full` is the first paint (or a forced one); `patch` rewrote only the changed lines. */
  readonly mode: "full" | "patch" | "none";
  readonly changedLines: number;
  readonly totalLines: number;
}

export type ControlKind = "approval" | "select" | "text";
export interface Control {
  readonly id: string;
  readonly kind: ControlKind;
  readonly label: string;
}

export interface InteractiveTerminal {
  /** The current frame: the snapshot, then the controls footer when there are controls. */
  frame(): string;
  /** The controls in reading order, with the focused one's id. */
  controls(): readonly Control[];
  focused(): string | undefined;
  /** Feed raw input (what a TTY would deliver). Resolves when every effect, incl. an action, has settled. */
  send(chunk: string): Promise<void>;
  /** Feed decoded keys. */
  press(...keys: Key[]): Promise<void>;
  /** Land a revised Blueprint: only the lines that changed are repainted; focus follows the control's id. */
  update(next: Blueprint): void;
  /** Detach from the input, the store and the output. Idempotent. */
  stop(): void;
}

type Mode =
  | { readonly kind: "nav" }
  | { readonly kind: "text"; readonly draft: string }
  | { readonly kind: "pick"; readonly index: number };

/** Every widget under `layout`, in document order (a grid child is a `GridCell` holding its node). */
function widgetsOf(layout: Layout): Widget[] {
  const out: Widget[] = [];
  const visit = (node: Widget | Layout): void => {
    if ("_tag" in node) {
      out.push(node);
      return;
    }
    for (const child of node.children) visit("node" in child ? child.node : child);
  };
  visit(layout);
  return out;
}

const propLabel = (raw: unknown): string =>
  typeof raw === "string" ? oneLineChatText(raw, 80) : "";

/** Run the renderer as a live, keyboard-driven session. */
export function interactiveTerminal(
  initial: Blueprint,
  opts: InteractiveOptions
): InteractiveTerminal {
  const { store, onAction, input, output, onPaint, labels, compile } = opts;
  const say = createSay(opts.i18n as LuI18n | undefined);
  const focusMark = labels?.focus ?? "▸";
  const hint = labels?.hint ?? "⇥ ⏎ ⎋";
  const renderOpts: RenderExperienceOptions = (({
    store: _s,
    onAction: _a,
    input: _i,
    output: _o,
    onPaint: _p,
    onInterrupt: _t,
    labels: _l,
    compile: _c,
    ...rest
  }) => rest)(opts);

  let blueprint = initial;
  let focusId: string | undefined;
  let mode: Mode = { kind: "nav" };
  let note = "";
  let previous: string[] | undefined;
  let stopped = false;
  let current = "";
  let queue: Promise<void> = Promise.resolve();
  /** The APPROVE/REJECT already sent for a pending approval: further y/n are ignored until the frame moves. */
  let answered: { readonly id: string; readonly fp: string } | undefined;

  const boundValue = (w: Widget): unknown => {
    const p = w.binding?.path;
    if (p === undefined || !p.startsWith(`${HYDRATION_VALUES_PREFIX}.`)) return undefined;
    return store.value(p.slice(HYDRATION_VALUES_PREFIX.length + 1));
  };

  const statusOf = (w: Widget): { state: string; seq?: number } | undefined => {
    if (w.binding === undefined) return undefined;
    const st = store.status(w.binding.path.slice(HYDRATION_VALUES_PREFIX.length + 1));
    return st === undefined
      ? undefined
      : { state: st.state, ...(st.seq !== undefined && { seq: st.seq }) };
  };

  /** What the viewer was looking at when a key ARRIVED: the blueprint id and every control's binding status. */
  interface Snapshot {
    readonly id: string;
    readonly statuses: ReadonlyMap<string, { state: string; seq?: number } | undefined>;
    readonly fp: string;
  }
  function capture(): Snapshot {
    const statuses = new Map<string, { state: string; seq?: number } | undefined>();
    const parts: unknown[] = [blueprint.id];
    for (const c of controlsNow()) {
      const st = statusOf(c.widget);
      statuses.set(c.id, st);
      parts.push([c.id, c.kind, st?.state, st?.seq]);
    }
    return { id: blueprint.id, statuses, fp: JSON.stringify(parts) };
  }

  function controlsNow(): Array<Control & { widget: Widget }> {
    const out: Array<Control & { widget: Widget }> = [];
    for (const w of widgetsOf(blueprint.layout)) {
      const label = propLabel(w.props.label) || propLabel(w.title);
      if (w.kind === "ApprovalCard") {
        // Like the web: no pending approval, no controls.
        if (boundValue(w))
          out.push({
            id: w.id,
            kind: "approval",
            label: label || say("lu.approval.approve"),
            widget: w,
          });
      } else if (w.kind === "SelectInput") {
        if (optionsProblem(w.props.options) === undefined)
          out.push({ id: w.id, kind: "select", label: label || say("lu.input.choose"), widget: w });
      } else if (w.kind === "TextInput") {
        out.push({ id: w.id, kind: "text", label: label || say("lu.input.message"), widget: w });
      }
    }
    return out;
  }

  const optionsOf = (w: Widget): ReadonlyArray<{ value: string; label: string }> =>
    optionsProblem(w.props.options) === undefined
      ? (w.props.options as ReadonlyArray<{ value: string; label: string }>)
      : [];

  function build(): string {
    const body = renderExperience(blueprint, store, renderOpts);
    const controls = controlsNow();
    if (controls.length === 0) return inert(body);
    if (focusId === undefined || !controls.some((c) => c.id === focusId)) {
      focusId = controls[0]?.id;
      mode = { kind: "nav" };
    }
    const lines: string[] = ["─".repeat(24)];
    for (const c of controls) {
      const focused = c.id === focusId;
      const mark = focused ? focusMark : " ";
      if (c.kind === "approval") {
        lines.push(
          `${mark} ${c.label}  [y] ${say("lu.approval.approve")}  [n] ${say("lu.approval.reject")}`
        );
      } else if (c.kind === "text") {
        const editing = focused && mode.kind === "text";
        lines.push(
          `${mark} ${c.label}: ${editing ? `${(mode as { draft: string }).draft}▏` : "…"}`
        );
      } else {
        lines.push(`${mark} ${c.label}`);
        const w = controls.find((x) => x.id === c.id)?.widget;
        if (focused && mode.kind === "pick" && w !== undefined) {
          const at = mode.index;
          optionsOf(w).forEach((o, i) =>
            lines.push(`   ${i === at ? "›" : " "} ${i + 1}) ${oneLineChatText(o.label, 60)}`)
          );
        }
      }
    }
    if (note !== "") lines.push(note);
    lines.push(hint);
    // The WHOLE frame is made inert, footer included: the i18n words, the hint and focus marks, and
    // the draft echo are as host- or viewer-authored as any title.
    return inert(`${body}${lines.join("\n")}\n`);
  }

  function paint(force = false): void {
    if (stopped) return;
    current = build();
    const next = current.replace(/\n$/, "").split("\n");
    const prev = previous;
    previous = next;
    if (output === undefined) return;
    if (prev === undefined || force) {
      output.write(`${CLEAR_SCREEN}${next.join("\n")}\n`);
      onPaint?.({ mode: "full", changedLines: next.length, totalLines: next.length });
      return;
    }
    const patches = diffFrames(prev, next);
    if (patches.length > 0) output.write(paintPatches(patches, next.length));
    onPaint?.({
      mode: patches.length === 0 ? "none" : "patch",
      changedLines: patches.length,
      totalLines: next.length,
    });
  }

  async function dispatch(
    action: { type: string; widgetId: string; payload?: unknown },
    w: Widget,
    snap: Snapshot
  ) {
    if (onAction === undefined) {
      note = say("lu.chat.dispatch.unavailable");
      return false;
    }
    // Stamped from what the viewer saw when the key ARRIVED, not from whatever is current by the
    // time a queued key runs.
    const status = snap.statuses.get(w.id);
    const stamped: StampedAction = {
      ...action,
      viewedVersion: viewedVersionOf(snap.id, status, compile),
    };
    note = say("lu.chat.sending");
    paint();
    try {
      const out = (await onAction(stamped)) as Partial<ActionOutcome> | null | undefined;
      if (typeof out === "object" && out !== null && out.ok === false) {
        note = say(out.reason === "stale" ? "lu.chat.dispatch.stale" : "lu.chat.dispatch.failed");
        return false;
      }
      note = say("lu.input.sent");
      return true;
    } catch {
      note = say("lu.chat.dispatch.failed");
      return false;
    }
  }

  /** `"stop"` = drop the rest of this input chunk (a submit, a refusal, or a consent key that was not alone). */
  type Outcome = "stop" | undefined;

  /**
   * A consent key (y/n on an approval, any submit) acts only when it is the SOLE key of its input
   * chunk and the frame it was pressed on is still the current one. Otherwise it is refused.
   */
  function consent(sole: boolean, snap: Snapshot): boolean {
    if (!sole) return false;
    if (snap.fp !== capture().fp) {
      note = say("lu.chat.dispatch.stale");
      return false;
    }
    return true;
  }

  async function handle(key: Key, sole: boolean, snap: Snapshot): Promise<Outcome> {
    if (key.name === "interrupt") {
      (opts.onInterrupt ?? stop)();
      return "stop";
    }
    if (key.name === "char" && !isPrintableChar(key.char)) return undefined;
    const controls = controlsNow();
    const i = controls.findIndex((c) => c.id === focusId);
    const c = controls[i];
    if (c === undefined) return undefined;
    if (mode.kind === "text") {
      if (key.name === "escape") mode = { kind: "nav" };
      else if (key.name === "backspace")
        mode = { kind: "text", draft: Array.from(mode.draft).slice(0, -1).join("") };
      else if (key.name === "char") mode = { kind: "text", draft: mode.draft + (key.char ?? "") };
      else if (key.name === "paste") mode = { kind: "text", draft: mode.draft + (key.text ?? "") };
      else if (key.name === "enter") {
        if (!consent(sole, snap)) return "stop";
        const v = validateTextValue(mode.draft);
        if (!v.ok) {
          note = v.error === "too-long" ? say("lu.input.error.tooLong") : say("lu.chat.typeFirst");
        } else {
          const ok = await dispatch(
            {
              type: SUBMIT_TEXT_ACTION,
              widgetId: c.id,
              payload: { text: v.text, key: newSubmitKey() },
            },
            c.widget,
            snap
          );
          // Like the web: what was typed is kept until the host says it arrived.
          if (ok) mode = { kind: "nav" };
          return "stop";
        }
      }
      return undefined;
    }
    if (mode.kind === "pick") {
      const options = optionsOf(c.widget);
      let choose: number | undefined;
      if (key.name === "escape") mode = { kind: "nav" };
      else if (key.name === "up") mode = { kind: "pick", index: Math.max(0, mode.index - 1) };
      else if (key.name === "down")
        mode = { kind: "pick", index: Math.min(options.length - 1, mode.index + 1) };
      else if (key.name === "enter") choose = mode.index;
      else if (key.name === "char" && key.char !== undefined && /^[1-9]$/.test(key.char))
        choose = Number(key.char) - 1;
      if (choose !== undefined) {
        const picked = options[choose];
        const v = picked === undefined ? undefined : validateSelectValue(options, picked.value);
        if (v?.ok === true) {
          if (!consent(sole, snap)) return "stop";
          const ok = await dispatch(
            {
              type: SELECT_ACTION,
              widgetId: c.id,
              payload: { value: v.value, key: newSubmitKey() },
            },
            c.widget,
            snap
          );
          if (ok) mode = { kind: "nav" };
          return "stop";
        }
      }
      return undefined;
    }
    // Navigation. A paste is text: with no draft open it is nothing.
    if (key.name === "paste") return undefined;
    note = "";
    const move = (d: number): void => {
      focusId = controls[(i + d + controls.length) % controls.length]?.id;
    };
    if (key.name === "tab" || key.name === "down") move(1);
    else if (key.name === "shift-tab" || key.name === "up") move(-1);
    else if (
      c.kind === "approval" &&
      key.name === "char" &&
      (key.char === "y" || key.char === "n")
    ) {
      if (!consent(sole, snap)) return "stop";
      // One answer per pending approval: until the frame moves (the host answered, or a new
      // version landed) a second y/n is ignored, so a repeat cannot double-submit.
      if (answered !== undefined && answered.id === c.id && answered.fp === snap.fp) return "stop";
      const approved = key.char === "y";
      const ok = await dispatch(
        { type: approved ? "APPROVE" : "REJECT", widgetId: c.id, payload: { approved } },
        c.widget,
        snap
      );
      answered = ok ? { id: c.id, fp: snap.fp } : undefined;
      return "stop";
    } else if (key.name === "enter") {
      if (c.kind === "text") mode = { kind: "text", draft: "" };
      else if (c.kind === "select") mode = { kind: "pick", index: 0 };
    }
    return undefined;
  }

  const run = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };
  /** One INPUT CHUNK: the keys the terminal delivered together (a paste arrives this way). */
  async function chunkOf(keys: Key[]): Promise<void> {
    // The frame the keys were pressed on is captured NOW, before they queue behind anything.
    const snap = capture();
    const sole = keys.length === 1;
    await run(async () => {
      for (const k of keys) {
        if (stopped) return;
        const before = mode.kind;
        const out = await handle(k, sole, snap);
        paint();
        // A key that changed mode or submitted ends the chunk: what follows in the SAME chunk was
        // typed (or pasted) for the old mode, never for the new one.
        if (out === "stop" || mode.kind !== before) return;
      }
    });
  }
  /** Programmatic keys: each is its own arrival, in order (a caller pressing keys means each one). */
  async function press(...keys: Key[]): Promise<void> {
    await Promise.all(keys.map((k) => chunkOf([k])));
  }

  const decode = createKeyDecoder();
  const onData = (chunk: string | Uint8Array): void => {
    void chunkOf(decode(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")));
  };

  // Bracketed paste is on while a session reads input AND paints, so a paste arrives wrapped.
  const pasteMode = input !== undefined && output !== undefined;
  const stops: Array<() => void> = [];
  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const s of stops.splice(0)) s();
    if (pasteMode) output?.write(PASTE_OFF);
  }

  stops.push(store.runtimeSubscribe(() => paint()));
  if (opts.projectionSubscribe !== undefined) stops.push(opts.projectionSubscribe(() => paint()));
  if (input !== undefined) {
    input.setRawMode?.(true);
    input.resume?.();
    input.on("data", onData);
    stops.push(() => {
      (input.off ?? input.removeListener)?.call(input, "data", onData);
      input.setRawMode?.(false);
    });
  }
  if (pasteMode) output?.write(PASTE_ON);
  paint();

  return {
    frame: () => current,
    controls: () => controlsNow().map(({ id, kind, label }) => ({ id, kind, label })),
    focused: () => focusId,
    send: (chunk) => chunkOf(decode(chunk)),
    press,
    update(next) {
      blueprint = next;
      paint();
    },
    stop,
  };
}
