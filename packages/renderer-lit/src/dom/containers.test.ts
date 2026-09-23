import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import {
  type Blueprint,
  type DataBinding,
  type Layout,
  MetricCard,
  RendererRegistry,
  type Widget,
  blueprint$,
  cell,
  flex,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import {
  type DomContainerProps,
  type DomContainerRenderer,
  type DomRenderOptions,
  type DomWidgetRenderer,
  renderBlueprintDom,
} from "./index";

// ── The container-renderer seam (Blueprint IR 2.2.0 `Layout.role`, loom ADR 0099) ─────────────
// An app registers a renderer for a container ROLE the way it registers one for a widget kind.
// The adapter keeps everything it owns — the body element, child mount / keyed reconcile /
// reorder / placement / focus pin, the section wrap — and the app owns only chrome and which of
// the children it is handed are visible.

const bind = (handle: string): DataBinding => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
  status: { path: hydrationStatusPath(handle) },
});

/** Widget renderers: a `<span>` showing the value, and a real `<textarea>` for NoteInput. */
const widgets = () => {
  const calls: string[] = [];
  const plain: DomWidgetRenderer = (host, props) => {
    const el = document.createElement("span");
    el.textContent = String(props.value);
    host.appendChild(el);
    calls.push(`mount:${props.widget.id}`);
    return {
      update: (value) => {
        el.textContent = String(value);
        calls.push(`update:${props.widget.id}`);
      },
      patch: (w) => calls.push(`patch:${w.id}`),
      dispose: () => calls.push(`dispose:${props.widget.id}`),
    };
  };
  const note: DomWidgetRenderer = (host, props) => {
    const ta = document.createElement("textarea");
    ta.dataset.note = props.widget.id;
    host.appendChild(ta);
    calls.push(`mount:${props.widget.id}`);
    return {
      update: () => calls.push(`update:${props.widget.id}`),
      patch: (w) => calls.push(`patch:${w.id}`),
      dispose: () => calls.push(`dispose:${props.widget.id}`),
    };
  };
  const registry = new RendererRegistry<DomWidgetRenderer>()
    .register("MetricCard", plain)
    .register("NoteInput", note);
  return { registry, calls };
};

const note = (id: string): Widget => ({
  _tag: "Widget" as const,
  id,
  kind: "NoteInput",
  title: "Note",
  props: {},
});
const metric = (id: string): Widget =>
  MetricCard({ id, title: id, binding: bind(`h-${id}`), unit: "ms" });

/**
 * A reference "stepped" container: Back/Next chrome before the body, exactly one child shown.
 * The current step lives in the handle's closure (chrome state), and every mount / update /
 * dispose is logged so a test can assert how often the adapter called it.
 */
const stepped = (log: string[], opts: { throwOnMount?: boolean; throwOnUpdate?: boolean } = {}) => {
  const renderer: DomContainerRenderer = (host, props) => {
    if (opts.throwOnMount) throw new Error("chrome exploded");
    let current = 0;
    let latest: DomContainerProps = props;
    const nav = document.createElement("nav");
    nav.dataset.chrome = "stepped";
    const back = document.createElement("button");
    back.textContent = "Back";
    const next = document.createElement("button");
    next.textContent = "Next";
    const position = document.createElement("span");
    position.setAttribute("aria-live", "polite");
    nav.append(back, position, next);
    host.insertBefore(nav, props.body);
    const show = (): void => {
      const n = latest.children.length;
      if (current >= n) current = Math.max(0, n - 1);
      latest.children.forEach((c, i) => {
        c.element.hidden = i !== current;
      });
      position.textContent = `Step ${current + 1} of ${n}`;
    };
    back.addEventListener("click", () => {
      current = Math.max(0, current - 1);
      show();
    });
    next.addEventListener("click", () => {
      current = Math.min(latest.children.length - 1, current + 1);
      show();
    });
    show();
    log.push(`mount:${props.children.length}`);
    return {
      update: (p) => {
        if (opts.throwOnUpdate) throw new Error("chrome update exploded");
        latest = p;
        show();
        log.push(`update:${p.children.length}`);
      },
      dispose: () => {
        nav.remove();
        log.push("dispose");
      },
    };
  };
  return renderer;
};

const containersWith = (role: string, renderer: DomContainerRenderer) =>
  new RendererRegistry<DomContainerRenderer>().register(role, renderer);

/** Three step containers under one roled column — the shape a stepped section compiles to. */
const onboarding = (
  opts: {
    role?: string;
    title?: string;
    steps?: readonly string[];
    gap?: number;
    stepTitles?: Record<string, string>;
    /** IR 2.4.0: give the roled column and every step a layout id (the step's name). */
    ids?: boolean;
  } = {}
): Blueprint =>
  blueprint$({
    id: "e@1",
    title: "Onboarding",
    projections: [HYDRATION_PROJECTION_ID],
    layout: grid({
      columns: 12,
      children: [
        cell(4, metric("summary")),
        cell(
          8,
          flex({
            ...(opts.ids && { id: "steps" }),
            direction: "column",
            ...(opts.role !== undefined && { role: opts.role }),
            ...(opts.title !== undefined && { title: opts.title }),
            ...(opts.gap !== undefined && { gap: opts.gap }),
            children: (opts.steps ?? ["account", "payment", "pickup"]).map((s) =>
              stack({
                ...(opts.ids && { id: s }),
                title: opts.stepTitles?.[s] ?? s,
                children: [s === "payment" ? note(`${s}-note`) : metric(s)],
              })
            ),
          })
        ),
      ],
    }),
  });

const setup = (bp: Blueprint, containers?: DomRenderOptions["containers"]) => {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "e" });
  for (const h of ["summary", "account", "payment", "pickup", "extra"])
    store.setValue(`h-${h}`, `${h}-v1`, { state: "ready" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const w = widgets();
  const handle = renderBlueprintDom(host, bp, {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: w.registry,
    ...(containers !== undefined && { containers }),
  });
  return { runtime, store, host, handle, calls: w.calls };
};

/** Tag + data-* + inline style + attributes + children — the DOM shape two mounts must share. */
const shape = (el: Element): unknown => ({
  tag: el.tagName,
  attrs: [...el.attributes].map((a) => `${a.name}=${a.value}`).sort(),
  text: el.children.length === 0 ? el.textContent : undefined,
  children: [...el.children].map(shape),
});

const observe = (host: HTMLElement) => {
  const observer = new MutationObserver(() => {});
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  return () => {
    const records = observer.takeRecords();
    observer.disconnect();
    return records;
  };
};

const roleHost = (host: HTMLElement) =>
  host.querySelector("[data-container-role]") as HTMLElement | null;
const stepEls = (host: HTMLElement) =>
  [...(roleHost(host)?.querySelector(":scope > [data-layout='flex']")?.children ?? [])].map(
    (e) => e as HTMLElement
  );

describe("container renderers — mount", () => {
  it("a registered role mounts chrome in a role host around the adapter's body, every child under the body in order", () => {
    const log: string[] = [];
    let seen: DomContainerProps | undefined;
    const spy: DomContainerRenderer = (h, p) => {
      seen = p;
      return stepped(log)(h, p);
    };
    const { host, handle } = setup(onboarding({ role: "stepped" }), containersWith("stepped", spy));
    const rh = roleHost(host) as HTMLElement;
    expect(rh.dataset.containerRole).toBe("stepped");
    expect(rh.getAttribute("role")).toBeNull(); // a role is never an ARIA role (ADR 0099 D1)
    expect([...rh.children].map((c) => c.tagName)).toEqual(["NAV", "DIV"]);
    const body = rh.children[1] as HTMLElement;
    expect(body.dataset.layout).toBe("flex");
    expect(seen?.body).toBe(body);
    expect(seen?.layout.role).toBe("stepped");
    expect(seen?.children.map((c) => c.element)).toEqual([...body.children]);
    expect(seen?.children.map((c) => (c.node as Layout).title)).toEqual([
      "account",
      "payment",
      "pickup",
    ]);
    // The role host is the grid item: placement lands on it, not on the body.
    expect(rh.style.gridColumn).toBe("span 8");
    expect(body.style.gridColumn).toBe("");
    // Only step 1 is shown; every widget is mounted.
    expect(stepEls(host).map((e) => e.hidden)).toEqual([false, true, true]);
    expect(host.querySelectorAll("[data-widget-id]").length).toBe(4);
    expect(log).toEqual(["mount:3"]);
    handle.dispose();
    expect(log).toEqual(["mount:3", "dispose"]);
  });

  it("a titled roled container keeps the adapter's heading: section > h2 + role host > chrome + body", () => {
    const { host, handle } = setup(
      onboarding({ role: "stepped", title: "Rider onboarding" }),
      containersWith("stepped", stepped([]))
    );
    const section = host.querySelector("section[aria-label='Rider onboarding']") as HTMLElement;
    expect([...section.children].map((c) => c.tagName)).toEqual(["H2", "DIV"]);
    expect(section.children[0]?.textContent).toBe("Rider onboarding");
    expect(section.children[1]).toBe(roleHost(host));
    expect(section.style.gridColumn).toBe("span 8");
    expect((roleHost(host) as HTMLElement).style.gridColumn).toBe("");
    handle.dispose();
  });

  it("no registry, an unknown role, or a malformed role draws the plain container — DOM-identical to no role", () => {
    const plain = setup(onboarding());
    const expected = shape(plain.handle.element);
    plain.handle.dispose();
    const cases: Array<[Blueprint, DomRenderOptions["containers"]]> = [
      [onboarding({ role: "stepped" }), undefined],
      [onboarding({ role: "tabbed" }), containersWith("stepped", stepped([]))],
      [onboarding({ role: "Stepped" }), containersWith("Stepped", stepped([]))],
      [onboarding({ role: "__proto__" }), containersWith("__proto__", stepped([]))],
    ];
    for (const [bp, containers] of cases) {
      const s = setup(bp, containers);
      expect(roleHost(s.host)).toBeNull();
      expect(shape(s.handle.element)).toEqual(expected);
      s.handle.dispose();
    }
  });

  it("a renderer that throws on mount falls back to the plain container — children kept, still subscribed", () => {
    const plain = setup(onboarding());
    const expected = shape(plain.handle.element);
    plain.handle.dispose();
    const { host, handle, store } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", stepped([], { throwOnMount: true }))
    );
    expect(roleHost(host)).toBeNull();
    expect(shape(handle.element)).toEqual(expected);
    store.setValue("h-pickup", "pickup-v2", { state: "ready" });
    expect(host.querySelector("[data-widget-id='pickup']")?.textContent).toBe("pickup-v2");
    handle.dispose();
  });

  it("a renderer that returns no update() is refused like a throw — update is required", () => {
    const noUpdate = (() => ({ dispose: () => {} })) as unknown as DomContainerRenderer;
    const { host, handle } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", noUpdate)
    );
    expect(roleHost(host)).toBeNull();
    expect(host.querySelectorAll("[data-widget-id]").length).toBe(4);
    handle.dispose();
  });

  it("a role on the ROOT layout is honoured too", () => {
    const bp = blueprint$({
      id: "e@1",
      title: "Root",
      projections: [HYDRATION_PROJECTION_ID],
      layout: flex({ direction: "column", role: "stepped", children: [metric("a"), metric("b")] }),
    });
    const { host, handle } = setup(bp, containersWith("stepped", stepped([])));
    const rh = roleHost(host) as HTMLElement;
    expect(rh.parentElement).toBe(handle.element);
    expect(
      [...(rh.querySelector(":scope > [data-layout]")?.children ?? [])].map(
        (e) => (e as HTMLElement).hidden
      )
    ).toEqual([false, true]);
    handle.dispose();
  });
});

describe("container renderers — update", () => {
  it("an identical blueprint makes ZERO DOM mutations and never calls the container's update", () => {
    const log: string[] = [];
    const { host, handle } = setup(
      onboarding({ role: "stepped", title: "Rider onboarding" }),
      containersWith("stepped", stepped(log))
    );
    const done = observe(host);
    const r = handle.update(onboarding({ role: "stepped", title: "Rider onboarding" }));
    expect(done()).toEqual([]);
    expect(r).toMatchObject({ remounted: [], rebound: [], findings: [] });
    expect(log).toEqual(["mount:3"]);
    handle.dispose();
  });

  it("a step appended or removed calls update once with the new list — nothing remounted, chrome state kept", () => {
    const log: string[] = [];
    const { host, handle } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", stepped(log))
    );
    (host.querySelector("nav button:last-child") as HTMLButtonElement).click(); // → step 2
    expect(stepEls(host).map((e) => e.hidden)).toEqual([true, false, true]);
    const nav = host.querySelector("nav");

    const r1 = handle.update(
      onboarding({ role: "stepped", steps: ["account", "payment", "pickup", "extra"] })
    );
    expect(r1).toMatchObject({ remounted: [], findings: [] });
    expect(log).toEqual(["mount:3", "update:4"]);
    expect(host.querySelector("nav")).toBe(nav); // chrome kept, not remounted
    expect(stepEls(host).map((e) => e.hidden)).toEqual([true, false, true, true]);
    expect(host.querySelector("[aria-live]")?.textContent).toBe("Step 2 of 4");

    const r2 = handle.update(onboarding({ role: "stepped", steps: ["account", "payment"] }));
    expect(r2).toMatchObject({ remounted: [], findings: [] });
    expect(log).toEqual(["mount:3", "update:4", "update:2"]);
    expect(stepEls(host).map((e) => e.hidden)).toEqual([true, false]);
    handle.dispose();
  });

  it("widget children reordered: update once with the new element order, nothing remounted", () => {
    const board = (ids: readonly string[]): Blueprint =>
      blueprint$({
        id: "e@1",
        title: "Board",
        projections: [HYDRATION_PROJECTION_ID],
        layout: flex({ direction: "column", role: "stepped", children: ids.map(metric) }),
      });
    let seen: DomContainerProps | undefined;
    const log: string[] = [];
    const { host, handle } = setup(
      board(["account", "payment", "pickup"]),
      containersWith("stepped", (h, p) => {
        const inner = stepped(log)(h, p);
        return {
          update: (q) => {
            seen = q;
            inner.update(q);
          },
          dispose: inner.dispose,
        };
      })
    );
    const before = new Map(
      [...host.querySelectorAll("[data-widget-id]")].map((e) => [
        e.getAttribute("data-widget-id"),
        e,
      ])
    );
    const r = handle.update(board(["pickup", "account", "payment"]));
    expect(r).toMatchObject({ remounted: [], findings: [] });
    expect(log).toEqual(["mount:3", "update:3"]);
    expect(seen?.children.map((c) => c.element)).toEqual(
      ["pickup", "account", "payment"].map((id) => before.get(id))
    );
    expect(seen?.children.map((c) => c.element)).toEqual([...(seen?.body.children ?? [])]);
    handle.dispose();
  });

  it("a change to the layout's OWN fields (gap, title) calls update once; a change to a child's own fields (a step title) does too", () => {
    const log: string[] = [];
    const { handle } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", stepped(log))
    );
    handle.update(onboarding({ role: "stepped", gap: 8 }));
    expect(log).toEqual(["mount:3", "update:3"]);
    handle.update(onboarding({ role: "stepped", gap: 8, title: "Onboarding" }));
    expect(log).toEqual(["mount:3", "update:3", "update:3"]);
    let seen: DomContainerProps | undefined;
    const spyLog: string[] = [];
    const s = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", (h, p) => {
        const inner = stepped(spyLog)(h, p);
        return {
          update: (q) => {
            seen = q;
            inner.update(q);
          },
          dispose: inner.dispose,
        };
      })
    );
    s.handle.update(onboarding({ role: "stepped", stepTitles: { payment: "Pay" } }));
    expect(spyLog).toEqual(["mount:3", "update:3"]);
    expect(seen?.children.map((c) => (c.node as Layout).title)).toEqual([
      "account",
      "Pay",
      "pickup",
    ]);
    handle.dispose();
    s.handle.dispose();
  });

  it("role added, removed or changed REMOUNTS the container — old chrome disposed, its widgets reported", () => {
    const log: string[] = [];
    const tabs: string[] = [];
    const containers = containersWith("stepped", stepped(log)).merge(
      containersWith("tabbed", stepped(tabs))
    );
    const { host, handle } = setup(onboarding(), containers);
    const ids = ["account", "payment-note", "pickup"];

    const added = handle.update(onboarding({ role: "stepped" }));
    expect(added.remounted).toEqual(ids);
    expect(log).toEqual(["mount:3"]);
    expect(roleHost(host)?.dataset.containerRole).toBe("stepped");

    const changed = handle.update(onboarding({ role: "tabbed" }));
    expect(changed.remounted).toEqual(ids);
    expect(log).toEqual(["mount:3", "dispose"]);
    expect(tabs).toEqual(["mount:3"]);
    expect(roleHost(host)?.dataset.containerRole).toBe("tabbed");
    expect(host.querySelectorAll("nav").length).toBe(1);

    const removed = handle.update(onboarding());
    expect(removed.remounted).toEqual(ids);
    expect(tabs).toEqual(["mount:3", "dispose"]);
    expect(roleHost(host)).toBeNull();
    expect(host.querySelector("nav")).toBeNull();
    // `summary` sits beside the container and was never touched.
    expect(removed.remounted).not.toContain("summary");
    handle.dispose();
  });

  it("an unknown-to-known role change remounts too — role is part of the key whatever the registry holds", () => {
    const { handle } = setup(
      onboarding({ role: "tabbed" }),
      containersWith("stepped", stepped([]))
    );
    expect(handle.update(onboarding({ role: "stepped" })).remounted).toEqual([
      "account",
      "payment-note",
      "pickup",
    ]);
    handle.dispose();
  });

  it("a ROOT role change remounts the root, reported", () => {
    const root = (role?: string): Blueprint =>
      blueprint$({
        id: "e@1",
        title: "Root",
        projections: [HYDRATION_PROJECTION_ID],
        layout: flex({
          direction: "column",
          ...(role !== undefined && { role }),
          children: [metric("account"), metric("pickup")],
        }),
      });
    const log: string[] = [];
    const { host, handle } = setup(root(), containersWith("stepped", stepped(log)));
    const r = handle.update(root("stepped"));
    expect(r.remounted).toEqual(["account", "pickup"]);
    expect(r.findings).toEqual([]);
    expect(roleHost(host)?.parentElement).toBe(handle.element);
    expect(handle.element.querySelectorAll(":scope > [data-layout]").length).toBe(0);
    expect(handle.element.querySelector("h1")?.textContent).toBe("Root");
    expect(log).toEqual(["mount:2"]);
    const back = handle.update(root());
    expect(back.remounted).toEqual(["account", "pickup"]);
    expect(log).toEqual(["mount:2", "dispose"]);
    expect(roleHost(host)).toBeNull();
    handle.dispose();
  });

  it("a renderer that throws on update falls back to plain: patch-failed naming role and path, chrome disposed, children un-hidden and still subscribed", () => {
    const log: string[] = [];
    const { host, handle, store } = setup(
      onboarding({ role: "stepped", title: "Rider onboarding" }),
      containersWith("stepped", stepped(log, { throwOnUpdate: true }))
    );
    expect(stepEls(host).map((e) => e.hidden)).toEqual([false, true, true]);
    // A chrome that animates keeps a step in layout as inert + aria-hidden instead (Q3).
    stepEls(host)[1]?.setAttribute("inert", "");
    stepEls(host)[1]?.setAttribute("aria-hidden", "true");
    const r = handle.update(onboarding({ role: "stepped", title: "Rider onboarding", gap: 4 }));
    expect(r.remounted).toEqual([]);
    expect(r.findings).toEqual([
      {
        code: "patch-failed",
        nodeId: "",
        message: expect.stringMatching(/"stepped".*layout\.children\[1\].*chrome update exploded/),
      },
    ]);
    expect(log).toEqual(["mount:3", "dispose"]);
    expect(roleHost(host)).toBeNull();
    const section = host.querySelector("section[aria-label='Rider onboarding']") as HTMLElement;
    const body = section.children[1] as HTMLElement;
    expect(body.dataset.layout).toBe("flex");
    expect([...body.children].map((e) => (e as HTMLElement).hidden)).toEqual([false, false, false]);
    expect(body.querySelector(":scope > [inert], :scope > [aria-hidden]")).toBeNull();
    expect(host.querySelector("nav")).toBeNull();
    store.setValue("h-pickup", "pickup-v2", { state: "ready" });
    expect(host.querySelector("[data-widget-id='pickup']")?.textContent).toBe("pickup-v2");
    // Fallen back, it stays plain: the same role is not retried on the next update.
    const again = handle.update(onboarding({ role: "stepped", title: "Rider onboarding", gap: 6 }));
    expect(again.findings).toEqual([]);
    expect(log).toEqual(["mount:3", "dispose"]);
    handle.dispose();
  });

  it("a renderer that throws mounting during update is mount-failed, and the container is plain", () => {
    const { host, handle } = setup(
      onboarding(),
      containersWith("stepped", stepped([], { throwOnMount: true }))
    );
    const r = handle.update(onboarding({ role: "stepped" }));
    expect(r.findings).toEqual([
      {
        code: "mount-failed",
        nodeId: "",
        message: expect.stringMatching(/"stepped".*layout\.children\[1\].*chrome exploded/),
      },
    ]);
    expect(roleHost(host)).toBeNull();
    expect(host.querySelectorAll("[data-widget-id]").length).toBe(4);
    handle.dispose();
  });

  it("a HIDDEN step's widget keeps receiving projection updates", () => {
    const { host, handle, store } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", stepped([]))
    );
    expect(stepEls(host)[2]?.hidden).toBe(true);
    store.setValue("h-pickup", "pickup-v2", { state: "ready" });
    expect(host.querySelector("[data-widget-id='pickup']")?.textContent).toBe("pickup-v2");
    handle.dispose();
  });

  it("a focused control in the shown step keeps focus and value across a sibling reorder through a custom container", () => {
    const log: string[] = [];
    const { host, handle } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", stepped(log))
    );
    (host.querySelector("nav button:last-child") as HTMLButtonElement).click(); // → payment
    const ta = host.querySelector("textarea[data-note='payment-note']") as HTMLTextAreaElement;
    ta.focus();
    ta.value = "card ending 42";
    ta.setSelectionRange(5, 5);
    // Steps are containers, keyed by ordinal: the focused step keeps its ordinal (1) and is kept;
    // its two siblings swap content, which is a remount of their widgets — reported.
    const r = handle.update(
      onboarding({ role: "stepped", steps: ["pickup", "payment", "account"] })
    );
    expect(r).toMatchObject({ remounted: ["pickup", "account"], findings: [] });
    expect(log).toEqual(["mount:3", "update:3"]); // the step titles changed: labels to re-read
    expect(stepEls(host).map((e) => e.hidden)).toEqual([true, false, true]);
    expect(host.querySelector("textarea[data-note='payment-note']")).toBe(ta);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("card ending 42");
    expect(ta.selectionStart).toBe(5);
    handle.dispose();
  });

  it("title wrap/unwrap moves the ROLE HOST — chrome, widgets and focus kept", () => {
    const log: string[] = [];
    const { host, handle } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", stepped(log))
    );
    const rh = roleHost(host) as HTMLElement;
    const nav = host.querySelector("nav");
    const gridEl = host.querySelector("[data-layout='grid']") as HTMLElement;
    const ta = host.querySelector("textarea[data-note='payment-note']") as HTMLTextAreaElement;
    ta.focus();
    ta.value = "typed";

    const titled = handle.update(onboarding({ role: "stepped", title: "Rider onboarding" }));
    expect(titled).toMatchObject({ remounted: [], findings: [] });
    const section = host.querySelector("section[aria-label='Rider onboarding']") as HTMLElement;
    expect(section.parentElement).toBe(gridEl);
    expect(section.children[1]).toBe(rh);
    expect(host.querySelector("nav")).toBe(nav);
    expect(document.activeElement).toBe(ta);
    expect([section.style.gridColumn, rh.style.gridColumn]).toEqual(["span 8", ""]);

    const untitled = handle.update(onboarding({ role: "stepped" }));
    expect(untitled).toMatchObject({ remounted: [], findings: [] });
    expect(host.querySelector("section[aria-label='Rider onboarding']")).toBeNull();
    expect(rh.parentElement).toBe(gridEl);
    expect(rh.style.gridColumn).toBe("span 8");
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("typed");
    expect(log).toEqual(["mount:3", "update:3", "update:3"]);
    handle.dispose();
  });

  it("keyed recompose THROUGH a custom container: kept widgets untouched, a widget moved between steps remounted and reported, a new one mounted", () => {
    const board = (steps: Record<string, readonly Widget[]>): Blueprint =>
      blueprint$({
        id: "e@1",
        title: "Board",
        projections: [HYDRATION_PROJECTION_ID],
        layout: flex({
          direction: "column",
          role: "stepped",
          children: Object.entries(steps).map(([title, children]) =>
            stack({ title, children: [...children] })
          ),
        }),
      });
    const log: string[] = [];
    const { host, handle, calls } = setup(
      board({ one: [metric("account"), metric("summary")], two: [metric("pickup")] }),
      containersWith("stepped", stepped(log))
    );
    const account = host.querySelector("[data-widget-id='account']");
    const pickup = host.querySelector("[data-widget-id='pickup']");
    calls.length = 0;
    const r = handle.update(
      board({
        one: [metric("account")],
        two: [metric("pickup"), metric("summary"), metric("extra")],
      })
    );
    expect(r.findings).toEqual([]);
    expect(r.remounted).toEqual(["summary"]);
    expect(host.querySelector("[data-widget-id='account']")).toBe(account);
    expect(host.querySelector("[data-widget-id='pickup']")).toBe(pickup);
    expect(calls.filter((c) => c.startsWith("mount:"))).toEqual(["mount:summary", "mount:extra"]);
    // The step list itself did not change (same two step elements, same own fields), so the
    // chrome was not called: what moved lives INSIDE a step, which the adapter reconciles alone.
    expect(log).toEqual(["mount:2"]);
    handle.dispose();
  });

  it("a focused control keeps focus and selection when its widget is reordered among a custom container's children (the focus pin)", () => {
    const board = (ids: readonly string[]): Blueprint =>
      blueprint$({
        id: "e@1",
        title: "Board",
        projections: [HYDRATION_PROJECTION_ID],
        layout: flex({
          direction: "column",
          role: "stepped",
          children: ids.map((id) => (id === "memo" ? note(id) : metric(id))),
        }),
      });
    const log: string[] = [];
    const { host, handle } = setup(
      board(["memo", "account", "pickup"]),
      containersWith("stepped", stepped(log))
    );
    const ta = host.querySelector("textarea[data-note='memo']") as HTMLTextAreaElement;
    ta.focus();
    ta.value = "half-typed";
    ta.setSelectionRange(4, 4);
    const r = handle.update(board(["account", "pickup", "memo"]));
    expect(r).toMatchObject({ remounted: [], findings: [] });
    expect(log).toEqual(["mount:3", "update:3"]);
    expect(host.querySelector("textarea[data-note='memo']")).toBe(ta);
    expect(document.activeElement).toBe(ta);
    expect(ta.selectionStart).toBe(4);
    const body = roleHost(host)?.querySelector(":scope > [data-layout]") as HTMLElement;
    expect([...body.children].map((e) => e.getAttribute("data-widget-id"))).toEqual([
      "account",
      "pickup",
      "memo",
    ]);
    handle.dispose();
  });
});

describe("container renderers — dispose", () => {
  it("dispose() disposes the chrome; a chrome dispose that throws is aggregated, the element still removed", () => {
    const boom: DomContainerRenderer = () => ({
      update: () => {},
      dispose: () => {
        throw new Error("chrome dispose exploded");
      },
    });
    const { host, handle } = setup(
      onboarding({ role: "stepped" }),
      containersWith("stepped", boom)
    );
    expect(() => handle.dispose()).toThrow(AggregateError);
    expect(host.children.length).toBe(0);
  });
});

describe("container renderers — containers keyed by id (IR 2.4.0, loom ADR 0101)", () => {
  it("a step inserted ABOVE the focused, typed-in step: nothing remounted, chrome kept, update once, focus and value kept", () => {
    const log: string[] = [];
    const { host, handle } = setup(
      onboarding({ role: "stepped", ids: true, steps: ["account", "payment"] }),
      containersWith("stepped", stepped(log))
    );
    (host.querySelector("nav button:last-child") as HTMLButtonElement).click(); // → payment
    const nav = host.querySelector("nav");
    const ta = host.querySelector("textarea[data-note='payment-note']") as HTMLTextAreaElement;
    const accountHost = host.querySelector("[data-widget-id='account']");
    ta.focus();
    ta.value = "card ending 42";
    ta.setSelectionRange(5, 5);
    const r = handle.update(
      onboarding({ role: "stepped", ids: true, steps: ["account", "extra", "payment"] })
    );
    expect(r).toMatchObject({ remounted: [], findings: [] });
    expect(r.identity.added).toEqual(["extra"]);
    expect(log).toEqual(["mount:2", "update:3"]); // one update: the child list changed
    expect(host.querySelector("nav")).toBe(nav);
    expect(host.querySelector("[data-widget-id='account']")).toBe(accountHost);
    expect(host.querySelector("textarea[data-note='payment-note']")).toBe(ta);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("card ending 42");
    expect(ta.selectionStart).toBe(5);
    expect(
      stepEls(host).map((e) => e.querySelector("[data-widget-id]")?.getAttribute("data-widget-id"))
    ).toEqual(["account", "extra", "payment-note"]);
    handle.dispose();
  });

  it("steps REORDERED through a custom container: every step kept by id, update once, nothing remounted", () => {
    const log: string[] = [];
    const { host, handle } = setup(
      onboarding({ role: "stepped", ids: true }),
      containersWith("stepped", stepped(log))
    );
    const before = stepEls(host);
    const r = handle.update(
      onboarding({ role: "stepped", ids: true, steps: ["pickup", "payment", "account"] })
    );
    expect(r).toMatchObject({ remounted: [], findings: [] });
    expect(log).toEqual(["mount:3", "update:3"]);
    expect(stepEls(host)).toEqual([before[2], before[1], before[0]]);
    handle.dispose();
  });

  it("an identical id'd blueprint makes ZERO DOM mutations and never calls the container's update", () => {
    const log: string[] = [];
    const { host, handle } = setup(
      onboarding({ role: "stepped", ids: true }),
      containersWith("stepped", stepped(log))
    );
    const done = observe(host);
    const r = handle.update(onboarding({ role: "stepped", ids: true }));
    expect(done()).toEqual([]);
    expect(r).toMatchObject({ remounted: [], findings: [] });
    expect(log).toEqual(["mount:3"]);
    handle.dispose();
  });

  it("a container renderer's failure names the layout's id when it has one", () => {
    const { handle } = setup(
      onboarding({ role: "stepped", ids: true }),
      containersWith("stepped", stepped([], { throwOnUpdate: true }))
    );
    const r = handle.update(onboarding({ role: "stepped", ids: true, gap: 4 }));
    expect(r.findings).toEqual([
      {
        code: "patch-failed",
        nodeId: "steps",
        message: expect.stringContaining("chrome update exploded"),
      },
    ]);
    handle.dispose();
  });

  it("a container renderer that throws mounting during update is mount-failed against the layout's id", () => {
    const { handle } = setup(
      onboarding({ ids: true }),
      containersWith("stepped", stepped([], { throwOnMount: true }))
    );
    const r = handle.update(onboarding({ role: "stepped", ids: true }));
    expect(r.findings).toEqual([
      {
        code: "mount-failed",
        nodeId: "steps",
        message: expect.stringContaining("chrome exploded"),
      },
    ]);
    handle.dispose();
  });
});
