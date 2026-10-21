import { CHAT_REF_OPEN_ACTION } from "@loom-ui/core/chat-ui";
import { customWidget$ } from "@loom/blueprint-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-chat";

const b = { projectionId: "hydration", path: "values.h" };
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
type El = HTMLElement & { updateComplete: Promise<unknown> };
async function mount(value: unknown, onAction?: (a: unknown) => unknown): Promise<El> {
  const el = document.createElement("lu-chat") as El;
  Object.assign(el, {
    widget: customWidget$({ kind: "Chat", id: "chat", title: "t", binding: b, props: {} }),
    value,
    onAction,
  });
  document.body.appendChild(el);
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
  return el;
}
const reply = (status: string, text: string, refs?: unknown) => ({
  id: "t1.assistant",
  turn: 1,
  role: "assistant",
  status,
  parts: [{ type: "text", text }],
  ...(refs ? { refs } : {}),
});
const art = (el: El) =>
  el.shadowRoot?.querySelector("article[data-role='assistant']") as HTMLElement;

describe("lu-chat reference markers", () => {
  it("draws a listed marker as a numbered, named button, drops an unlisted one, and reports the click", async () => {
    const seen: unknown[] = [];
    const el = await mount(
      {
        refMarkers: true,
        entries: [reply("complete", "Due in 30 days [[a1]] and [[zzz]].", [{ id: "a1" }])],
      },
      (a) => {
        seen.push(a);
      }
    );
    const buttons = [...art(el).querySelectorAll<HTMLButtonElement>("button.ref")];
    expect(buttons.map((x) => [x.textContent, x.getAttribute("aria-label")])).toEqual([
      ["1", "Source 1"],
    ]);
    expect(art(el).querySelector("p.text")?.textContent).toBe("Due in 30 days 1 and.");
    buttons[0]?.click();
    expect(seen).toEqual([
      {
        type: CHAT_REF_OPEN_ACTION,
        widgetId: "chat",
        payload: { entryId: "t1.assistant", refId: "a1", n: 1 },
      },
    ]);
  });
  it("hides every marker while the reply streams", async () => {
    const el = await mount({
      refMarkers: true,
      entries: [reply("streaming", "Due in 30 days [[a1]] and [[b2", [{ id: "a1" }])],
    });
    expect(art(el).querySelectorAll("button.ref").length).toBe(0);
    expect(art(el).querySelector("p.text")?.textContent).not.toContain("[[");
  });
  it("does nothing to text when the source does not write markers", async () => {
    const el = await mount({ entries: [reply("complete", "Due [[a1]].", [{ id: "a1" }])] });
    expect(art(el).querySelectorAll("button.ref").length).toBe(0);
    expect(art(el).querySelector("p.text")?.textContent).toBe("Due [[a1]].");
  });
  it("never turns anything else in the text into markup", async () => {
    const el = await mount({
      refMarkers: true,
      entries: [reply("complete", "<b>x</b> [[a1]]", [{ id: "a1" }])],
    });
    expect(art(el).querySelectorAll("b").length).toBe(0);
    expect(art(el).querySelector("p.text")?.textContent).toContain("<b>x</b>");
  });

  it("awaits the host, ignores a second press while one is in flight (aria-disabled, focus kept), and says when the answer is a refusal", async () => {
    let release: (v: unknown) => void = () => {};
    const seen: unknown[] = [];
    const el = await mount(
      { refMarkers: true, entries: [reply("complete", "Due [[a1]].", [{ id: "a1" }])] },
      (a) => {
        seen.push(a);
        return new Promise((r) => {
          release = r;
        });
      }
    );
    const btn = () => art(el).querySelector("button.ref") as HTMLButtonElement;
    btn().focus();
    btn().click();
    btn().click();
    await el.updateComplete;
    expect(seen.length).toBe(1);
    // the status region is always present (empty until there is something to say)
    expect(el.shadowRoot?.querySelector("[data-ref-status]")?.textContent?.trim()).toBe("");
    expect(btn().getAttribute("aria-disabled")).toBe("true");
    expect(btn().disabled).toBe(false);
    expect(el.shadowRoot?.activeElement).toBe(btn());
    release({ ok: false, reason: "stale" });
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await el.updateComplete;
    }
    expect(btn().getAttribute("aria-disabled")).toBe("false");
    const status = el.shadowRoot?.querySelector("[data-ref-status]") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.hidden).toBe(false);
    expect(status.textContent?.trim()).not.toBe("");
    btn().click();
    expect(seen.length).toBe(2);
  });
  it("says it is unavailable when nothing handles the press", async () => {
    const el = await mount({
      refMarkers: true,
      entries: [reply("complete", "Due [[a1]].", [{ id: "a1" }])],
    });
    (art(el).querySelector("button.ref") as HTMLButtonElement).click();
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await el.updateComplete;
    }
    expect((el.shadowRoot?.querySelector("[data-ref-status]") as HTMLElement).hidden).toBe(false);
  });
});
