import { HydrationStore } from "@loom-ui/hydration";
import type { HandleEntry, RendererAdapter } from "@loom-ui/renderer-conformance";
import type { Blueprint, Layout, Widget } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { type InteractiveTerminal, interactiveTerminal } from "./interactive";

/** The terminal renderer, driven through its interactive session, as the conformance kit sees it. */
export const terminalAdapter: RendererAdapter = {
  name: "@loom-ui/renderer-terminal",
  surface: "terminal",
  kinds: [
    "MetricCard",
    "StatusBadge",
    "ApprovalCard",
    "Kpi",
    "Table",
    "StatusCard",
    "BarChart",
    "TimeSeries",
    "Note",
    "Prose",
    "Image",
    "Chat",
    "TextInput",
    "SelectInput",
    "MultiSelectInput",
  ],
  capabilities: {
    update: true,
    invoke: true,
    i18n: true,
    interpretsControlCharacters: true,
    chatMarkdown: true,
  },
  mount(blueprint, { values, onAction, i18n }) {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "kit" });
    const latest = new Map<string, HandleEntry>(Object.entries(values));
    const put = (handle: string, e: HandleEntry): void => {
      latest.set(handle, e);
      const finding =
        e.message === undefined
          ? undefined
          : { code: "kit", severity: "error" as const, message: e.message };
      const status = {
        state: e.state ?? "ready",
        ...(finding === undefined ? {} : { finding }),
      };
      if (e.value === undefined && e.state === undefined) store.remove(handle);
      else if (e.value === undefined) store.setStatus(handle, status);
      else store.setValue(handle, e.value, status);
    };
    for (const [h, e] of Object.entries(values)) put(h, e);
    const term: InteractiveTerminal = interactiveTerminal(blueprint, {
      store,
      onAction,
      ...(i18n === undefined ? {} : { i18n }),
    });
    const focus = async (id: string): Promise<void> => {
      for (let i = 0; i < 64 && term.focused() !== id; i++) await term.send("\t");
      if (term.focused() !== id) throw new Error(`cannot focus "${id}"`);
    };
    return {
      text: () => term.frame(),
      set: (h, e) => put(h, e),
      update: (next) => term.update(next),
      async invoke(id, intent) {
        await focus(id);
        if (intent.kind === "approve") await term.send("y");
        else if (intent.kind === "reject") await term.send("n");
        else if (intent.kind === "text") {
          await term.send("\r");
          await term.send(`\x1b[200~${intent.text}\x1b[201~`);
          await term.send("\r");
        } else if (intent.kind === "select-many") {
          // The options are the BOUND value's; the checklist opens on Enter with the cursor on the first.
          const handle = /^values\.(.+)$/.exec(widgetOf(blueprint, id)?.binding?.path ?? "")?.[1];
          const bound = (handle === undefined ? undefined : latest.get(handle)?.value) as
            | { options: Array<{ value: string }> }
            | undefined;
          const options = (bound?.options ?? []).map((o) => o.value);
          await term.send("\r");
          let at = 0;
          for (const value of intent.values) {
            const to = options.indexOf(value);
            if (to < 0) throw new Error(`no option "${value}"`);
            for (; at < to; at++) await term.send("\x1b[B");
            for (; at > to; at--) await term.send("\x1b[A");
            await term.send(" ");
          }
          await term.send("\r");
        } else {
          await term.send("\r");
          const options = (optionsOf(blueprint, id) as Array<{ value: string }>).map(
            (o) => o.value
          );
          const at = options.indexOf(intent.value);
          await term.send(String(at + 1));
        }
      },
      dispose: () => term.stop(),
    };
  },
};

function optionsOf(bp: Blueprint, id: string): unknown {
  return widgetOf(bp, id)?.props.options;
}

function widgetOf(bp: Blueprint, id: string): Widget | undefined {
  const find = (n: Widget | Layout): Widget | undefined => {
    if ("_tag" in n) return n.id === id ? n : undefined;
    for (const c of n.children) {
      const hit = find("node" in c ? c.node : c);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return find(bp.layout);
}
