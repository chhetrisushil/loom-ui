import { HydrationStore } from "@loom-ui/hydration";
import type { HandleEntry, InvokeIntent, RendererAdapter } from "@loom-ui/renderer-conformance";
import type { Blueprint } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { vi } from "vitest";
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
    for (const a of ["aria-label", "title", "alt"]) {
      const v = el.getAttribute(a);
      if (v) parts.push(v);
    }
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
    "Image",
    "Chat",
    "TextInput",
    "SelectInput",
  ],
  capabilities: { update: true, invoke: true, i18n: true },
  mount(blueprint, { values, onAction, i18n }) {
    vi.stubGlobal("IntersectionObserver", undefined);
    if (i18n !== undefined) {
      configureI18n(i18n);
      if (i18n.locale !== undefined) setLocale(i18n.locale);
    }
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "kit" });
    const put = (handle: string, e: HandleEntry): void => {
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
      onAction,
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
