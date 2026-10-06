import { STEPPER_ROLE, TABS_ROLE } from "@loom-ui/core/browser";
import { RendererRegistry } from "@loom/blueprint-runtime";
import { t } from "../i18n";
import type {
  DomContainerHandle,
  DomContainerProps,
  DomContainerRegistry,
  DomContainerRenderer,
} from "./registry";

// ── Reference container renderers (U15) ───────────────────────────────────────────────────────
// The two roles `@loom-ui/core`'s `REFERENCE_CONTAINER_ROLES` names, drawn through the container
// seam (Blueprint IR 2.2.0 `Layout.role`, loom ADR 0099): the adapter keeps `body` and every child
// (mount, keyed reconcile, reorder, placement, focus pin); these own only chrome beside `body` and
// which child is visible. Neither adds, removes, reorders or restyles a child — visibility is the
// only thing set on one (`hidden` + `inert` + `aria-hidden`, undone on dispose).
//
// Opt-in on purpose: `renderBlueprintDom({ containers: referenceContainers() })`. A host that
// registers nothing draws every role-carrying container as the plain container, children intact —
// which is also what the terminal renderer does — so an experience a planner composed with these
// roles degrades to a titled stack, never to a lost child.
//
// Each child is expected to be a titled container (the role spec: `children: "panels"`); its title
// is the tab's / step's label, and a child without one falls back to its ordinal.

const hide = (el: HTMLElement): void => {
  el.hidden = true;
  el.setAttribute("inert", "");
  el.setAttribute("aria-hidden", "true");
};
const show = (el: HTMLElement): void => {
  el.hidden = false;
  el.removeAttribute("inert");
  el.removeAttribute("aria-hidden");
};

const labelOf = (props: DomContainerProps, i: number, what: string): string => {
  const title = props.children[i]?.node.title;
  return typeof title === "string" && title !== "" ? title : `${what} ${i + 1}`;
};

/** A process-unique suffix for the ids chrome hands its children's `aria-labelledby`. */
let serial = 0;

/**
 * A tab set: a `role="tablist"` of real buttons before `body`, one panel visible. Roving tabindex,
 * Left/Right/Home/End move and select (automatic activation); each panel gets `role="tabpanel"` and
 * `aria-labelledby`, undone on dispose. The selected tab survives an `update`, clamped when panels go.
 */
export function tabsContainer(): DomContainerRenderer {
  return (host, initial): DomContainerHandle => {
    let props = initial;
    let current = 0;
    const uid = `lu-tabs-${++serial}`;
    const list = document.createElement("div");
    list.setAttribute("role", "tablist");
    list.dataset.chrome = "tabs";
    host.insertBefore(list, props.body);
    // The panels this chrome decorated, so a panel that left (or a dispose) is undone.
    let decorated: HTMLElement[] = [];

    const undo = (el: HTMLElement): void => {
      show(el);
      el.removeAttribute("role");
      el.removeAttribute("aria-labelledby");
    };
    const select = (i: number, focus = false): void => {
      current = i;
      render();
      if (focus) (list.children[i] as HTMLElement | undefined)?.focus();
    };
    const render = (): void => {
      const n = props.children.length;
      if (current > n - 1) current = Math.max(0, n - 1);
      for (const el of decorated) if (!props.children.some((c) => c.element === el)) undo(el);
      decorated = props.children.map((c) => c.element);
      props.children.forEach((child, i) => {
        const on = i === current;
        if (on) show(child.element);
        else hide(child.element);
        child.element.setAttribute("role", "tabpanel");
        child.element.setAttribute("aria-labelledby", `${uid}-tab-${i}`);
      });
      list.replaceChildren(
        ...props.children.map((_, i) => {
          const tab = document.createElement("button");
          tab.type = "button";
          tab.id = `${uid}-tab-${i}`;
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(i === current));
          tab.tabIndex = i === current ? 0 : -1;
          tab.textContent = labelOf(props, i, t("container.tab", "Tab"));
          tab.addEventListener("click", () => select(i));
          tab.addEventListener("keydown", (e) => {
            const last = props.children.length - 1;
            const to =
              e.key === "ArrowRight"
                ? (i + 1) % (last + 1)
                : e.key === "ArrowLeft"
                  ? (i - 1 + last + 1) % (last + 1)
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? last
                      : undefined;
            if (to === undefined) return;
            e.preventDefault();
            select(to, true);
          });
          return tab;
        })
      );
    };
    render();
    return {
      update(updated) {
        props = updated;
        render();
      },
      dispose() {
        for (const el of decorated) undo(el);
        list.remove();
      },
    };
  };
}

/**
 * A stepper: step list, Back / Next and a polite position line before `body`; exactly one step
 * visible, in order. The current step lives in this closure and lasts as long as the container.
 */
export function stepperContainer(): DomContainerRenderer {
  return (host, initial): DomContainerHandle => {
    let props = initial;
    let current = 0;
    const nav = document.createElement("nav");
    nav.dataset.chrome = "stepper";
    nav.setAttribute("aria-label", t("container.steps", "Steps"));
    const dots = document.createElement("ol");
    dots.dataset.chromePart = "steps";
    const back = document.createElement("button");
    back.type = "button";
    back.dataset.chromeAction = "back";
    back.textContent = t("container.back", "Back");
    const position = document.createElement("span");
    position.dataset.chromePart = "position";
    position.setAttribute("aria-live", "polite");
    const next = document.createElement("button");
    next.type = "button";
    next.dataset.chromeAction = "next";
    next.textContent = t("container.next", "Next");
    nav.append(dots, back, position, next);
    host.insertBefore(nav, props.body);

    const render = (): void => {
      const n = props.children.length;
      if (current > n - 1) current = Math.max(0, n - 1);
      props.children.forEach((c, i) => (i === current ? show(c.element) : hide(c.element)));
      dots.replaceChildren(
        ...props.children.map((_, i) => {
          const li = document.createElement("li");
          li.textContent = labelOf(props, i, t("container.step", "Step"));
          if (i === current) li.setAttribute("aria-current", "step");
          return li;
        })
      );
      position.textContent =
        n === 0
          ? ""
          : `${t("container.step", "Step")} ${current + 1} / ${n}: ${labelOf(props, current, t("container.step", "Step"))}`;
      back.disabled = current === 0;
      next.disabled = n === 0 || current >= n - 1;
    };
    back.addEventListener("click", () => {
      if (current > 0) {
        current -= 1;
        render();
      }
    });
    next.addEventListener("click", () => {
      if (current < props.children.length - 1) {
        current += 1;
        render();
      }
    });
    render();
    return {
      update(updated) {
        props = updated;
        render();
      },
      dispose() {
        for (const c of props.children) show(c.element);
        nav.remove();
      },
    };
  };
}

/** `tabs` and `stepper`, registered under the roles `@loom-ui/core` names (`REFERENCE_CONTAINER_ROLES`). */
export function referenceContainers(): DomContainerRegistry {
  return new RendererRegistry<DomContainerRenderer>()
    .register(TABS_ROLE, tabsContainer())
    .register(STEPPER_ROLE, stepperContainer());
}
