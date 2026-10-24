import { HydrationStore } from "@loom-ui/hydration";
import type { HandleEntry, InvokeIntent, RendererAdapter } from "@loom-ui/renderer-conformance";
import type { Blueprint, Layout, Widget, WidgetAction } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { vi } from "vitest";
import "./register";
import { registerChatWidgets } from "./chat";
import { createLitRegistry } from "./dom/litRegistry";
import { renderBlueprintDom } from "./dom/renderBlueprintDom";
import { configureI18n, setLocale } from "./i18n";
import { registerMediaWidgets } from "./media";

type Settled = Element & { updateComplete?: Promise<unknown> };

/** Every element under `root`, descending into open shadow roots, in document order. */
function* elements(root: ParentNode): Generator<Settled> {
  for (const el of Array.from(root.querySelectorAll("*")) as Settled[]) {
    yield el;
    if (el.shadowRoot) yield* elements(el.shadowRoot);
  }
}

/** Wait for every Lit element to finish rendering, until a pass finds nothing left to wait for. */
async function settle(host: HTMLElement): Promise<void> {
  for (let round = 0; round < 6; round++) {
    await Promise.resolve();
    const pending = [...elements(host)].flatMap((e) =>
      e.updateComplete ? [e.updateComplete] : []
    );
    await Promise.all(pending);
  }
}

/** What a viewer can read: text nodes and accessible names, in document order. */
function readable(root: ParentNode): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) parts.push(node.textContent ?? "");
    if (node.nodeType !== 1) {
      for (const c of Array.from(node.childNodes)) walk(c);
      return;
    }
    const el = node as Element;
    if (el.tagName === "STYLE" || el.tagName === "SCRIPT") return;
    // Every attribute that carries something a viewer, a screen reader or a link-follower is given
    // counts as READ: names, form values and placeholders, link targets, and data-* hooks.
    for (const a of el.getAttributeNames()) {
      if (
        !["aria-label", "title", "alt", "value", "placeholder", "href"].includes(a) &&
        !a.startsWith("data-")
      )
        continue;
      const v = el.getAttribute(a);
      if (v) parts.push(v);
    }
    // A chosen option is something a viewer is shown (the select reads as its choice).
    if (
      el.tagName === "OPTION" &&
      (el as HTMLOptionElement).selected &&
      (el as HTMLOptionElement).value !== ""
    )
      parts.push("(selected)");
    if (el.shadowRoot) walk(el.shadowRoot);
    for (const c of Array.from(el.childNodes)) walk(c);
  };
  walk(root as Node);
  return parts.join(" ");
}

const widgetEl = (host: HTMLElement, id: string): Element => {
  const el = [...elements(host)].find((e) => e.getAttribute("data-widget-id") === id);
  if (!el) throw new Error(`no widget "${id}" on the page`);
  return el;
};
const inner = (el: Element, sel: string): HTMLElement | null => {
  for (const e of elements(el as unknown as ParentNode))
    if (e.matches(sel)) return e as HTMLElement;
  return null;
};

function blueprintWidget(bp: Blueprint, id: string): Widget | undefined {
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

/** The Lit web renderer, with the chat and media entries registered, as the conformance kit sees it. */
export const litAdapter: RendererAdapter = {
  name: "@loom-ui/renderer-lit",
  surface: "web",
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
  capabilities: { update: true, invoke: true, i18n: true, chatMarkdown: true },
  mount(blueprint, { values, onAction, i18n }) {
    vi.stubGlobal("IntersectionObserver", undefined);
    if (i18n !== undefined) {
      configureI18n(i18n);
      if (i18n.locale !== undefined) setLocale(i18n.locale);
    }
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "kit" });
    // The latest entry per handle, so a multi-select drive can republish the chosen set as a host would.
    const latest = new Map<string, HandleEntry>(Object.entries(values));
    // While a `select-many` drive is running, the control's sends are held here (it sends the whole
    // set on each add); only the last reaches the kit, which counts one action per drive.
    let held: WidgetAction[] | undefined;
    const forward: typeof onAction = (a) => {
      if (held === undefined) return onAction(a);
      held.push(a);
      return { ok: true };
    };
    const put = (handle: string, e: HandleEntry): void => {
      latest.set(handle, e);
      const finding =
        e.message === undefined
          ? undefined
          : { code: "kit", severity: "error" as const, message: e.message };
      const status = { state: e.state ?? "ready", ...(finding === undefined ? {} : { finding }) };
      if (e.value === undefined && e.state === undefined) store.remove(handle);
      else if (e.value === undefined) store.setStatus(handle, status);
      else store.setValue(handle, e.value, status);
    };
    for (const [h, e] of Object.entries(values)) put(h, e);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const registry = registerMediaWidgets(registerChatWidgets(createLitRegistry()));
    const handle = renderBlueprintDom(host, blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
      onAction: forward,
    });
    let live = true;
    return {
      async text() {
        await settle(host);
        return readable(host);
      },
      async set(h, e) {
        put(h, e);
        await settle(host);
      },
      async update(next: Blueprint) {
        handle.update(next);
        await settle(host);
      },
      async invoke(id: string, intent: InvokeIntent) {
        await settle(host);
        const w = widgetEl(host, id);
        if (intent.kind === "approve" || intent.kind === "reject") {
          const buttons = [...elements(w as unknown as ParentNode)].filter(
            (e) => e.tagName === "BUTTON"
          );
          const button = buttons[intent.kind === "approve" ? 0 : 1] as HTMLElement | undefined;
          if (!button) throw new Error("no approval buttons");
          button.click();
        } else if (intent.kind === "select-many") {
          const handle = /^values\.(.+)$/.exec(
            blueprintWidget(blueprint, id)?.binding?.path ?? ""
          )?.[1];
          const entry = handle === undefined ? undefined : latest.get(handle);
          if (handle === undefined || entry === undefined) throw new Error("no bound multi-select");
          held = [];
          try {
            // Add each value in the order driven; between adds the host republishes the new set (the
            // control shows only the BOUND value and is busy until its send settles).
            for (const value of intent.values) {
              // Add opens the search; it stays open after an add, so click it only when closed.
              if (!inner(w, "input[data-search]")) {
                const add = inner(w, "[data-add]") as HTMLElement | null;
                if (!add) throw new Error("no Add button");
                add.click();
                await settle(host);
              }
              const option = inner(w, `[data-option="${CSS.escape(value)}"]`);
              if (!option) throw new Error(`no option "${value}"`);
              option.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true })
              );
              await settle(host);
              const sent = held.at(-1)?.payload as { values: string[] } | undefined;
              if (sent === undefined) throw new Error("the control sent nothing");
              const cur = latest.get(handle)?.value as Record<string, unknown>;
              put(handle, { ...entry, value: { ...cur, selected: sent.values } });
              await settle(host);
            }
          } finally {
            const last = held.at(-1);
            held = undefined;
            if (last !== undefined) await onAction(last);
          }
        } else if (intent.kind === "select") {
          const sel = inner(w, "select") as HTMLSelectElement | null;
          if (!sel) throw new Error("no select");
          sel.value = intent.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          const field = inner(w, "textarea, input") as HTMLInputElement | null;
          const form = inner(w, "form");
          if (!field || !form) throw new Error("no text field");
          field.value = intent.text;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        }
        await settle(host);
      },
      dispose() {
        if (!live) return;
        live = false;
        handle.dispose();
        host.remove();
        configureI18n(undefined);
        setLocale("en-US");
        vi.unstubAllGlobals();
      },
    };
  },
};
