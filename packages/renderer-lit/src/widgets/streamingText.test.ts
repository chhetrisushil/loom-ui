import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import "../register";

type El = HTMLElement & { updateComplete: Promise<unknown> };
const widget = customWidget$({
  kind: "StreamingText",
  id: "t",
  binding: { projectionId: "hydration", path: "values.t" },
});
const mount = async (props: Record<string, unknown>): Promise<El> => {
  const el = document.createElement("lu-text") as El;
  Object.assign(el, { widget, ...props });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};

describe("lu-text as a token stream", () => {
  it("appends in place: the same text node/element survives each chunk (no remount, no focus loss)", async () => {
    const el = await mount({ value: "Hel", status: { state: "pending", seq: 1 } });
    const span = el.shadowRoot?.querySelector("[aria-live]");
    expect(span?.textContent).toBe("Hel");
    Object.assign(el, { value: "Hello", status: { state: "pending", seq: 2 } });
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("[aria-live]")).toBe(span);
    expect(span?.textContent).toBe("Hello");
  });

  it("announces appended text politely, additions only, and is busy until the stream is done", async () => {
    const el = await mount({ value: "a", status: { state: "pending", seq: 1 } });
    const live = el.shadowRoot?.querySelector("[aria-live]");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.getAttribute("aria-atomic")).toBe("false");
    expect(live?.getAttribute("aria-relevant")).toBe("additions text");
    expect(live?.getAttribute("aria-busy")).toBe("true");
    Object.assign(el, { value: "ab", status: { state: "ready", seq: 2 } });
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("[aria-live]")?.getAttribute("aria-busy")).toBe("false");
  });

  it("renders untrusted streamed text as text, never markup", async () => {
    const el = await mount({
      value: "<img src=x onerror=alert(1)>",
      status: { state: "ready", seq: 1 },
    });
    expect(el.shadowRoot?.querySelector("img")).toBeNull();
    expect(el.shadowRoot?.querySelector("[aria-live]")?.textContent).toBe(
      "<img src=x onerror=alert(1)>"
    );
  });
});
