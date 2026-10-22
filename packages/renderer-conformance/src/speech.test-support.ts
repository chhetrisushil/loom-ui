import {
  type LuI18n,
  chatTranscriptLines,
  checkKindValue,
  createSay,
  describeMedia,
} from "@loom-ui/core";
import {
  SELECT_ACTION,
  SELECT_MANY_ACTION,
  SUBMIT_TEXT_ACTION,
  newSubmitKey,
  stripUnsafeChars,
  validateSelectValue,
  validateTextValue,
} from "@loom-ui/core/chat-ui";
import type { Blueprint, Layout, Widget, WidgetAction } from "@loom/blueprint-runtime";
import type { HandleEntry, InvokeIntent, RendererAdapter } from "./adapter";

// A THIRD-PARTY renderer in ~100 lines: a "voice" surface that speaks a Blueprint as sentences. It
// is the worked example for README "Writing a renderer": it implements `RendererAdapter` over loom's
// `Blueprint` and nothing else of loom-ui's, and passes the whole conformance kit.

// Core's ONE unsafe set (controls incl. ESC/C1, bidi, zero-width, TAG), then whitespace folded.
const clean = (s: unknown): string =>
  stripUnsafeChars(String(s ?? ""))
    .replace(/\s+/g, " ")
    .trim();
const BINDING = /^values\.(.+)$/;
const SPOKEN = [
  "MetricCard",
  "StatusBadge",
  "ApprovalCard",
  "Kpi",
  "Table",
  "StatusCard",
  "Note",
  "Image",
  "Chat",
  "TextInput",
  "SelectInput",
  "MultiSelectInput",
];

export const speechAdapter: RendererAdapter = {
  name: "speech (reference third-party renderer)",
  surface: "voice",
  kinds: SPOKEN,
  capabilities: {
    update: true,
    invoke: true,
    i18n: true,
    interpretsControlCharacters: true,
    chatMarkdown: true,
  },
  mount(initial, { values, onAction, i18n }) {
    const data = new Map(Object.entries(values));
    const base = createSay(i18n as LuI18n | undefined);
    // A host's translated word is as untrusted as a title.
    const say = ((key: never, vars?: never) => clean(base(key, vars))) as typeof base;
    const nf = new Intl.NumberFormat(i18n?.locale ?? "en-US");
    let bp: Blueprint = initial;
    let live = true;
    const widgets = (n: Widget | Layout | { node: Widget | Layout }): Widget[] =>
      "_tag" in n ? [n] : "node" in n ? widgets(n.node) : (n.children as never[]).flatMap(widgets);

    const speak = (w: Widget): string => {
      // IR 2.5.0: withheld for the audience. Decided before anything else of the widget is read, so
      // its title, props, binding and kind cannot reach the sentence; the words are a constant.
      if (w.source?.redacted === true) return "⊘ redacted"; // loom's constant marker, as its own renderers draw it
      const title = clean(w.title ?? w.kind);
      const handle = BINDING.exec(w.binding?.path ?? "")?.[1];
      const e: HandleEntry | undefined = handle === undefined ? undefined : data.get(handle);
      const v = e?.value;
      if (w.binding !== undefined) {
        if (e?.state === "error") return `${title}: ${say("lu.state.error")}, ${clean(e.message)}`;
        if (e?.state === "empty") return `${title}: ${say("lu.empty.noData")}`;
        if (v === undefined) return `${title}: ${say("lu.state.loading")}`;
        const bad = checkKindValue(w.kind, v);
        if (!bad.ok) return `${title}: ${say("lu.state.error")}`;
      }
      const stale = e?.state === "stale" ? ` (${say("lu.state.stale")})` : "";
      const o = v as Record<string, unknown>;
      switch (w.kind) {
        case "Note":
          return `${title}: ${clean(w.props.text)}`;
        case "MetricCard":
        case "StatusBadge":
          return `${title}: ${clean(typeof v === "number" ? nf.format(v) : v)}${stale}`;
        case "Kpi":
          return `${title}: ${nf.format(o.value as number)}${stale}`;
        case "StatusCard":
          return `${title}: ${clean(o.level)}, ${clean(o.headline)}${stale}`;
        case "Table": {
          const rows = o.rows as unknown[][];
          return `${title}: ${rows.length === 0 ? say("lu.empty.noData") : rows.map((r) => r.map(clean).join(" ")).join("; ")}`;
        }
        case "Image":
          return `${title}: ${clean(describeMedia("Image", v as never, say))}`;
        case "Chat":
          return `${title}: ${
            chatTranscriptLines(v as never, { say })
              .map(clean)
              .join(". ") || say("lu.chat.empty")
          }`;
        case "ApprovalCard":
          return `${title}: ${v ? `${say("lu.approval.approve")} or ${say("lu.approval.reject")}?` : say("lu.approval.none")}`;
        case "TextInput":
          return `${title}: ${clean(w.props.label)}`;
        case "SelectInput":
          // The bound current choice is spoken as "(current)"; a value that is not a declared option marks none.
          return `${title}: ${((w.props.options as { value: string; label: string }[]) ?? []).map((x) => `${clean(x.label)}${x.value === v ? " (current)" : ""}`).join(", ")}`;
        case "MultiSelectInput": {
          // Every option is spoken, the chosen ones marked "(current)"; then the note.
          const m = v as {
            options: { value: string; label: string; hint?: string }[];
            selected: string[];
            note?: string;
          };
          const opts = m.options.map(
            (x) =>
              `${clean(x.label)}${x.hint === undefined ? "" : ` (${clean(x.hint)})`}${m.selected.includes(x.value) ? " (current)" : ""}`
          );
          return `${title}: ${clean(w.props.label) || say("lu.input.choose")}: ${opts.join(", ")}${m.note === undefined ? "" : `. ${clean(m.note)}`}`;
        }
        default:
          return `${title}: [${w.kind}]`; // not spoken here: refuse visibly, never drop
      }
    };
    const walk = (n: Widget | Layout | { node: Widget | Layout }): string[] =>
      "_tag" in n
        ? [speak(n)]
        : "node" in n
          ? walk(n.node)
          : [...(n.title ? [clean(n.title)] : []), ...(n.children as never[]).flatMap(walk)];

    return {
      text: () => `${clean(bp.title)}. ${walk(bp.layout).join(". ")}.`,
      set: (h, e) => void (live && data.set(h, e)),
      update(next) {
        bp = next;
      },
      dispose() {
        live = false;
      },
      invoke(id: string, intent: InvokeIntent) {
        const w = widgets(bp.layout).find((x) => x.id === id);
        const emit = (type: string, payload: unknown): void =>
          void onAction({ type, widgetId: id, payload } as WidgetAction);
        if (w?.kind === "ApprovalCard" && (intent.kind === "approve" || intent.kind === "reject"))
          emit(intent.kind === "approve" ? "APPROVE" : "REJECT", {
            approved: intent.kind === "approve",
          });
        else if (w?.kind === "SelectInput" && intent.kind === "select") {
          const v = validateSelectValue(w.props.options as never, intent.value);
          if (v.ok) emit(SELECT_ACTION, { value: v.value, key: newSubmitKey() });
        } else if (w?.kind === "MultiSelectInput" && intent.kind === "select-many") {
          const handle = BINDING.exec(w.binding?.path ?? "")?.[1];
          const m = (handle === undefined ? undefined : data.get(handle))?.value as
            | { options: { value: string }[] }
            | undefined;
          const known = new Set((m?.options ?? []).map((o) => o.value));
          const values = [...new Set(intent.values)];
          if (values.length > 0 && values.every((x) => known.has(x)))
            emit(SELECT_MANY_ACTION, { values, key: newSubmitKey() });
        } else if (w?.kind === "TextInput" && intent.kind === "text") {
          const v = validateTextValue(intent.text);
          if (v.ok) emit(SUBMIT_TEXT_ACTION, { text: v.text, key: newSubmitKey() });
        }
      },
    };
  },
};
