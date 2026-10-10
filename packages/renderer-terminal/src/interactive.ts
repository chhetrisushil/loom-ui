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
  validateSelectValue,
  validateTextValue,
} from "@loom-ui/core/chat-ui";
import type { HydrationStore } from "@loom-ui/hydration/client";
import type { Blueprint, Layout, Widget } from "@loom/blueprint-runtime";
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
  | "char";
export interface Key {
  readonly name: KeyName;
  /** The printable character, for `name: "char"`. */
  readonly char?: string;
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
 * Split a chunk of terminal input into keys. Unknown escape sequences (arrows left/right, function
 * keys, mouse reports) are dropped whole rather than leaking their bytes in as characters; a lone
 * ESC is `escape`. Printable code points become `char` keys, so a paste is a run of them.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    const hit = NAMED.find(([seq]) => rest.startsWith(seq));
    if (hit !== undefined) {
      keys.push({ name: hit[1] });
      i += hit[0].length;
      continue;
    }
    if (rest.startsWith("\x1b")) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC begins the sequences being matched
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest) ?? /^\x1bO[@-~]/.exec(rest);
      if (csi !== null) {
        i += csi[0].length;
        continue;
      }
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }
    const cp = rest.codePointAt(0) ?? 0;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    // Control characters and bidi overrides are never typed text.
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x202a && cp <= 0x202e)) continue;
    keys.push({ name: "char", char: ch });
  }
  return keys;
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

  const boundValue = (w: Widget): unknown => {
    const p = w.binding?.path;
    if (p === undefined || !p.startsWith(`${HYDRATION_VALUES_PREFIX}.`)) return undefined;
    return store.value(p.slice(HYDRATION_VALUES_PREFIX.length + 1));
  };

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
    if (controls.length === 0) return body;
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
    return `${body}${lines.join("\n")}\n`;
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
    w: Widget
  ) {
    if (onAction === undefined) {
      note = say("lu.chat.dispatch.unavailable");
      return false;
    }
    const status =
      w.binding === undefined
        ? undefined
        : store.status(w.binding.path.slice(HYDRATION_VALUES_PREFIX.length + 1));
    const stamped: StampedAction = {
      ...action,
      viewedVersion: viewedVersionOf(
        blueprint.id,
        status === undefined
          ? undefined
          : { state: status.state, ...(status.seq !== undefined && { seq: status.seq }) },
        compile
      ),
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

  async function handle(key: Key): Promise<void> {
    if (key.name === "interrupt") {
      (opts.onInterrupt ?? stop)();
      return;
    }
    const controls = controlsNow();
    const i = controls.findIndex((c) => c.id === focusId);
    const c = controls[i];
    if (c === undefined) return;
    if (mode.kind === "text") {
      if (key.name === "escape") mode = { kind: "nav" };
      else if (key.name === "backspace")
        mode = { kind: "text", draft: Array.from(mode.draft).slice(0, -1).join("") };
      else if (key.name === "char") mode = { kind: "text", draft: mode.draft + (key.char ?? "") };
      else if (key.name === "enter") {
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
            c.widget
          );
          // Like the web: what was typed is kept until the host says it arrived.
          if (ok) mode = { kind: "nav" };
        }
      }
      return;
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
          const ok = await dispatch(
            {
              type: SELECT_ACTION,
              widgetId: c.id,
              payload: { value: v.value, key: newSubmitKey() },
            },
            c.widget
          );
          if (ok) mode = { kind: "nav" };
        }
      }
      return;
    }
    // Navigation.
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
      const approved = key.char === "y";
      await dispatch(
        { type: approved ? "APPROVE" : "REJECT", widgetId: c.id, payload: { approved } },
        c.widget
      );
    } else if (key.name === "enter") {
      if (c.kind === "text") mode = { kind: "text", draft: "" };
      else if (c.kind === "select") mode = { kind: "pick", index: 0 };
    }
  }

  const run = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };
  async function press(...keys: Key[]): Promise<void> {
    await run(async () => {
      for (const k of keys) {
        if (stopped) return;
        await handle(k);
        paint();
      }
    });
  }

  const onData = (chunk: string | Uint8Array): void => {
    void press(
      ...decodeKeys(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    );
  };

  const stops: Array<() => void> = [];
  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const s of stops.splice(0)) s();
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
  paint();

  return {
    frame: () => current,
    controls: () => controlsNow().map(({ id, kind, label }) => ({ id, kind, label })),
    focused: () => focusId,
    send: (chunk) => press(...decodeKeys(chunk)),
    press,
    update(next) {
      blueprint = next;
      paint();
    },
    stop,
  };
}
