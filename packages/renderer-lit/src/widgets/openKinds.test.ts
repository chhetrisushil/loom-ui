import { type TemplateResult, html } from "lit";
import { customElement } from "lit/decorators.js";
import { describe, expect, it } from "vitest";
import { elementRenderer } from "../dom/litRegistry";
import "../register";
import { LuWidget } from "./base";

// U13 review round 1: a host's own kind rendered by a Lit widget is checked against the host's
// contracts, and an uncontracted one is rendered with an explicit `data-unchecked` marker.

@customElement("lu-test-gauge")
class LuTestGauge extends LuWidget {
  readonly kind = "SpokenGauge";
  protected renderReady(): TemplateResult {
    return html`<span>${String(this.value)}</span>`;
  }
}
void LuTestGauge;

const contracts = {
  SpokenGauge: {
    safeParse: (v: unknown) =>
      typeof v === "number"
        ? { success: true as const }
        : { success: false as const, error: { issues: [{ path: [], message: "not a number" }] } },
  },
};
const widget = { id: "g", kind: "SpokenGauge", title: "g", props: {} } as never;
const mount = async (props: Record<string, unknown>) => {
  const el = document.createElement("lu-test-gauge") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  Object.assign(el, { widget, ...props });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};

describe("a host kind in a Lit widget", () => {
  it("is checked against the contracts handed to it", async () => {
    const el = await mount({ value: "oops", contracts });
    expect(el.shadowRoot?.querySelector("[data-state='error']")).not.toBeNull();
    expect(el.shadowRoot?.querySelector("[data-unchecked]")).toBeNull();
    const ok = await mount({ value: 3, contracts });
    expect(ok.shadowRoot?.querySelector("[data-state='ready']")).not.toBeNull();
    expect(ok.shadowRoot?.querySelector("[data-unchecked]")).toBeNull();
  });
  it("renders, but marked unchecked, when no contract covers it", async () => {
    const el = await mount({ value: "anything" });
    expect(el.shadowRoot?.querySelector("[data-state='ready'][data-unchecked]")).not.toBeNull();
  });
  it("elementRenderer({contracts}) threads them into the element it mounts", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    elementRenderer("lu-test-gauge", { contracts })(host, { widget, value: "oops" });
    const el = host.firstElementChild as HTMLElement & { updateComplete: Promise<unknown> };
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("[data-state='error']")).not.toBeNull();
  });
  it("a framework kind is never marked unchecked", async () => {
    const el = document.createElement("lu-metric-card") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    Object.assign(el, { widget: { id: "m", kind: "MetricCard", title: "m", props: {} }, value: 1 });
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("[data-unchecked]")).toBeNull();
  });
});
