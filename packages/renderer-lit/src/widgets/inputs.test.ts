import {
  SELECT_ACTION,
  SUBMIT_FORM_ACTION,
  SUBMIT_TEXT_ACTION,
  isSubmitKey,
} from "@loom-ui/core/chat-ui";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-inputs";

// U8: the input widgets. One action per submit, stamped by the renderer and re-validated by the
// host; the draft survives a failed send and the retry carries the same idempotency key.

type Mounted = HTMLElement & {
  updateComplete: Promise<unknown>;
  value: unknown;
  widget: unknown;
};
const settle = async (el: Mounted) => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
};
type Act = { type: string; widgetId: string; payload: Record<string, unknown> };
const mount = async (
  tag: string,
  kind: string,
  props: Record<string, unknown>,
  onAction?: (a: Act) => unknown,
  extra: Record<string, unknown> = {}
) => {
  const el = document.createElement(tag) as Mounted;
  Object.assign(el, {
    widget: customWidget$({ kind, id: "in", title: "Input", props }),
    value: undefined,
    ...(onAction && { onAction }),
    ...extra,
  });
  document.body.appendChild(el);
  await settle(el);
  return el;
};
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;
const q = <T extends Element>(el: HTMLElement, sel: string) =>
  root(el).querySelector(sel) as T | null;
const type = (f: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  f.value = v;
  f.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = (el: HTMLElement) =>
  q<HTMLFormElement>(el, "form")?.dispatchEvent(
    new Event("submit", { cancelable: true, bubbles: true })
  );

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lu-text-input", () => {
  it("draws a labelled field with a status region that is always present (no layout shift)", async () => {
    const el = await mount(
      "lu-text-input",
      "TextInput",
      { label: "Your message", placeholder: "Ask…", submitLabel: "Ask" },
      () => undefined
    );
    expect(q(el, "label")?.textContent).toBe("Your message");
    expect(q(el, "label")?.getAttribute("for")).toBe("field");
    expect(q(el, "#field")?.getAttribute("placeholder")).toBe("Ask…");
    expect(q(el, "button")?.textContent).toBe("Ask");
    expect(q(el, "#status")?.getAttribute("role")).toBe("status");
    expect(q(el, "#field")?.getAttribute("aria-describedby")).toBe("status");
  });

  it("submits SUBMIT_TEXT with the text and a well-formed key, clears the draft on success and keeps focus in the field", async () => {
    const seen: Act[] = [];
    const el = await mount("lu-text-input", "TextInput", {}, (a) => void seen.push(a));
    const f = q<HTMLInputElement>(el, "#field") as HTMLInputElement;
    f.focus();
    type(f, "hello there");
    submit(el);
    await settle(el);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: SUBMIT_TEXT_ACTION,
      widgetId: "in",
      payload: { text: "hello there" },
    });
    expect(isSubmitKey(seen[0]?.payload.key)).toBe(true);
    expect(f.value).toBe("");
    expect(q(el, "#status")?.textContent).toBe("Sent");
    expect(root(el).activeElement).toBe(f);
  });

  it("a FAILED send keeps the draft; the retry carries the SAME key (so it cannot become a second turn); a success rotates it", async () => {
    const keys: string[] = [];
    const results = [{ ok: false, reason: "failed" }, { ok: true }, { ok: true }];
    const el = await mount("lu-text-input", "TextInput", {}, async (a) => {
      keys.push(a.payload.key as string);
      return results.shift();
    });
    const f = q<HTMLInputElement>(el, "#field") as HTMLInputElement;
    type(f, "first");
    submit(el);
    await settle(el);
    expect(f.value).toBe("first");
    expect(q(el, "#status")?.textContent).toBe("Not sent. Try again.");
    expect(q(el, "#status")?.getAttribute("role")).toBe("alert");
    submit(el);
    await settle(el);
    expect(keys[1]).toBe(keys[0]);
    expect(f.value).toBe("");
    type(f, "second");
    submit(el);
    await settle(el);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("a rejected promise is a failed send too; a stale answer says the view changed", async () => {
    let mode: "throw" | "stale" = "throw";
    const el = await mount("lu-text-input", "TextInput", {}, async () => {
      if (mode === "throw") throw new Error("ECONNREFUSED internal-host:5432 password=x");
      return { ok: false, reason: "stale" };
    });
    const f = q<HTMLInputElement>(el, "#field") as HTMLInputElement;
    type(f, "x");
    submit(el);
    await settle(el);
    expect(q(el, "#status")?.textContent).toBe("Not sent. Try again.");
    expect(root(el).innerHTML).not.toContain("password");
    mode = "stale";
    submit(el);
    await settle(el);
    expect(q(el, "#status")?.textContent).toBe("The view changed. Review it and send again.");
  });

  it("a double submit while a send is in flight is ignored, and the field is read-only (not disabled: focus stays)", async () => {
    let release: (v: unknown) => void = () => {};
    const seen: Act[] = [];
    const el = await mount("lu-text-input", "TextInput", {}, (a) => {
      seen.push(a);
      return new Promise((r) => {
        release = r;
      });
    });
    const f = q<HTMLInputElement>(el, "#field") as HTMLInputElement;
    f.focus();
    type(f, "once");
    submit(el);
    submit(el);
    submit(el);
    await settle(el);
    expect(seen).toHaveLength(1);
    expect(f.hasAttribute("readonly")).toBe(true);
    expect(f.hasAttribute("disabled")).toBe(false);
    expect(q<HTMLButtonElement>(el, "button")?.disabled).toBe(true);
    release({ ok: true });
    await settle(el);
    expect(f.hasAttribute("readonly")).toBe(false);
    expect(f.value).toBe("");
  });

  it("blank and over-long text never leave the widget; no handler says so instead of pretending", async () => {
    const seen: Act[] = [];
    const el = await mount(
      "lu-text-input",
      "TextInput",
      { maxChars: 10 },
      (a) => void seen.push(a)
    );
    const f = q<HTMLInputElement>(el, "#field") as HTMLInputElement;
    expect(f.getAttribute("maxlength")).toBe("10");
    type(f, "   ");
    submit(el);
    await settle(el);
    expect(q(el, "#status")?.textContent).toBe("Type a message first.");
    type(f, "01234567890123");
    submit(el);
    await settle(el);
    expect(q(el, "#status")?.textContent).toBe("That message is too long.");
    expect(seen).toEqual([]);
    const none = await mount("lu-text-input", "TextInput", {});
    type(q<HTMLInputElement>(none, "#field") as HTMLInputElement, "x");
    submit(none);
    await settle(none);
    expect(q(none, "#status")?.textContent).toBe("Sending is not available here.");
  });

  it("multi-line: Enter is a newline, Ctrl/Cmd+Enter sends, an IME composition never sends", async () => {
    const seen: Act[] = [];
    const el = await mount(
      "lu-text-input",
      "TextInput",
      { multiline: true },
      (a) => void seen.push(a)
    );
    const ta = q<HTMLTextAreaElement>(el, "textarea") as HTMLTextAreaElement;
    expect(q(el, "#hint")?.textContent).toBe("Press Ctrl+Enter to send.");
    type(ta, "line one\nline two");
    const key = (init: KeyboardEventInit) =>
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })
      );
    key({});
    key({ ctrlKey: true, isComposing: true });
    await settle(el);
    expect(seen).toHaveLength(0);
    key({ ctrlKey: true });
    await settle(el);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload.text).toBe("line one\nline two");
    type(ta, "again");
    key({ metaKey: true });
    await settle(el);
    expect(seen).toHaveLength(2);
  });

  it("sends the SANITISED text (escapes and bidi marks removed); an input never draws a value that reaches it", async () => {
    const seen: Act[] = [];
    const el = await mount("lu-text-input", "TextInput", {}, (a) => void seen.push(a));
    type(q<HTMLInputElement>(el, "#field") as HTMLInputElement, "hi\u001b[2J\u202e there");
    submit(el);
    await settle(el);
    expect(seen[0]?.payload.text).toBe("hi[2J there");
    const withValue = await mount("lu-text-input", "TextInput", {}, undefined, {
      value: "pre-filled by a bound value",
    });
    expect(q(withValue, "[data-state='error']")).not.toBeNull();
    expect(q(withValue, "input")).toBeNull();
  });
});

describe("lu-form-input", () => {
  const fields = [
    { name: "reason", label: "Reason", type: "textarea", required: true, maxLength: 20 },
    { name: "count", label: "Count", type: "number", min: 1, max: 10 },
    { name: "urgent", label: "Urgent", type: "boolean" },
    {
      name: "env",
      label: "Env",
      type: "select",
      options: [
        { value: "prod", label: "Production" },
        { value: "dev", label: "Dev" },
      ],
    },
  ];
  const control = (el: HTMLElement, name: string) =>
    q<HTMLInputElement & HTMLSelectElement>(el, `[data-name="${name}"]`) as HTMLInputElement &
      HTMLSelectElement;

  it("draws a labelled control per field, marks required, and submits SUBMIT_FORM with validated, normalised values", async () => {
    const seen: Act[] = [];
    const el = await mount(
      "lu-form-input",
      "FormInput",
      { label: "Rollback", fields },
      (a) => void seen.push(a)
    );
    expect(q(el, "[role=group]")?.getAttribute("aria-label")).toBe("Rollback");
    expect(root(el).querySelectorAll("label")).toHaveLength(4);
    expect(control(el, "reason").getAttribute("aria-required")).toBe("true");
    type(control(el, "reason"), "disk is full");
    type(control(el, "count"), "3");
    const box = control(el, "urgent");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    const sel = control(el, "env");
    sel.value = "prod";
    sel.dispatchEvent(new Event("change"));
    submit(el);
    await settle(el);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: SUBMIT_FORM_ACTION,
      payload: { values: { reason: "disk is full", count: 3, urgent: true, env: "prod" } },
    });
    expect(isSubmitKey(seen[0]?.payload.key)).toBe(true);
    expect(q(el, "[role=status]")?.textContent).toBe("Sent");
  });

  it("an invalid form sends nothing, marks and describes each bad field, and focuses the first", async () => {
    const seen: Act[] = [];
    const el = await mount("lu-form-input", "FormInput", { fields }, (a) => void seen.push(a));
    type(control(el, "count"), "99");
    submit(el);
    await settle(el);
    expect(seen).toEqual([]);
    expect(control(el, "reason").getAttribute("aria-invalid")).toBe("true");
    expect(control(el, "reason").getAttribute("aria-describedby")).toBe("f-reason-err");
    expect(q(el, "#f-reason-err")?.textContent).toBe("This field is required.");
    expect(q(el, "#f-count-err")?.textContent).toBe("This is out of range.");
    expect(root(el).activeElement).toBe(control(el, "reason"));
    // fixing a field clears its error as the user types
    type(control(el, "reason"), "ok");
    await settle(el);
    expect(control(el, "reason").getAttribute("aria-invalid")).toBe("false");
    expect(q(el, "#f-reason-err")).toBeNull();
  });

  it("a failed submit keeps every value and the retry uses the same key", async () => {
    const keys: string[] = [];
    let ok = false;
    const el = await mount("lu-form-input", "FormInput", { fields }, async (a) => {
      keys.push(a.payload.key as string);
      return ok ? { ok: true } : { ok: false };
    });
    type(control(el, "reason"), "kept");
    submit(el);
    await settle(el);
    expect(control(el, "reason").value).toBe("kept");
    ok = true;
    submit(el);
    await settle(el);
    expect(keys[1]).toBe(keys[0]);
    expect(control(el, "reason").value).toBe("");
  });

  it("an invalid field spec draws an unavailable note, never a half form", async () => {
    const el = await mount(
      "lu-form-input",
      "FormInput",
      { fields: [{ name: "__proto__", label: "x", type: "text" }] },
      () => undefined
    );
    expect(q(el, "form")).toBeNull();
    expect(root(el).textContent).toContain("This form is not available.");
  });
});

describe("lu-select-input", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ];
  it("emits SELECT {value,key} on change, a fresh key per choice, and only for a declared option", async () => {
    const seen: Act[] = [];
    const el = await mount(
      "lu-select-input",
      "SelectInput",
      { label: "Region", options },
      (a) => void seen.push(a)
    );
    const sel = q<HTMLSelectElement>(el, "select") as HTMLSelectElement;
    expect(q(el, "label")?.textContent).toBe("Region");
    expect(root(el).querySelectorAll("option")).toHaveLength(3); // placeholder + 2
    sel.value = "a";
    sel.dispatchEvent(new Event("change"));
    await settle(el);
    sel.value = "b";
    sel.dispatchEvent(new Event("change"));
    await settle(el);
    expect(seen.map((s) => [s.type, s.payload.value])).toEqual([
      [SELECT_ACTION, "a"],
      [SELECT_ACTION, "b"],
    ]);
    expect(seen[0]?.payload.key).not.toBe(seen[1]?.payload.key);
    // a value the spec does not declare (a tampered DOM) is not sent
    sel.value = "";
    const before = seen.length;
    const opt = document.createElement("option");
    opt.value = "evil";
    sel.appendChild(opt);
    sel.value = "evil";
    sel.dispatchEvent(new Event("change"));
    await settle(el);
    expect(seen.length).toBe(before);
  });

  it("a failed choice is undone so it can be made again", async () => {
    const el = await mount("lu-select-input", "SelectInput", { options }, async () => ({
      ok: false,
      reason: "failed",
    }));
    const sel = q<HTMLSelectElement>(el, "select") as HTMLSelectElement;
    sel.value = "b";
    sel.dispatchEvent(new Event("change"));
    await settle(el);
    expect(sel.value).toBe("");
    expect(q(el, "#status")?.textContent).toBe("Not sent. Try again.");
  });
});

describe("lu-select-input: a bound current value and a compact size", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ];
  const sel = (el: HTMLElement) => q<HTMLSelectElement>(el, "select") as HTMLSelectElement;
  const withValue = async (el: Mounted, value: unknown) => {
    el.value = value;
    await settle(el);
  };

  it("shows the bound value when it is a declared option; anything else is the placeholder, never echoed", async () => {
    const el = await mount("lu-select-input", "SelectInput", { options }, undefined, {
      value: "b",
    });
    expect(sel(el).value).toBe("b");
    await withValue(el, "zzz");
    expect(sel(el).value).toBe("");
    expect(root(el).textContent).not.toContain("zzz");
    await withValue(el, { x: 1 });
    expect(sel(el).value).toBe("");
    await withValue(el, "a");
    expect(sel(el).value).toBe("a");
  });

  it("follows a changed bound value; undefined (not loaded) keeps what is shown", async () => {
    const el = await mount("lu-select-input", "SelectInput", { options }, undefined, {
      value: "a",
    });
    await withValue(el, "b");
    expect(sel(el).value).toBe("b");
    await withValue(el, undefined);
    expect(sel(el).value).toBe("b");
  });

  it("a user change still emits SELECT unchanged, and a re-render with the same or an older bound value does not clobber the in-flight choice", async () => {
    const seen: Act[] = [];
    let release: (v: unknown) => void = () => undefined;
    const el = await mount(
      "lu-select-input",
      "SelectInput",
      { options },
      (a) => {
        seen.push(a);
        return new Promise((r) => {
          release = r;
        });
      },
      { value: "a" }
    );
    sel(el).value = "b";
    sel(el).dispatchEvent(new Event("change"));
    await settle(el);
    expect(seen.map((s) => [s.type, s.payload.value])).toEqual([[SELECT_ACTION, "b"]]);
    await withValue(el, "a"); // the server has not caught up yet
    el.widget = { ...(el.widget as object) }; // a recompile hands a fresh widget object
    await settle(el);
    expect(sel(el).value).toBe("b");
    release({ ok: true });
    await settle(el);
    expect(sel(el).value).toBe("b");
    await withValue(el, "b");
    expect(sel(el).value).toBe("b");
  });

  it("a failed choice goes back to the bound value", async () => {
    const el = await mount(
      "lu-select-input",
      "SelectInput",
      { options },
      async () => ({ ok: false, reason: "failed" }),
      { value: "a" }
    );
    sel(el).value = "b";
    sel(el).dispatchEvent(new Event("change"));
    await settle(el);
    expect(sel(el).value).toBe("a");
  });

  it("size compact sits inline (host attribute + part); default is unchanged", async () => {
    const d = await mount("lu-select-input", "SelectInput", { options });
    expect(d.hasAttribute("compact")).toBe(false);
    const c = await mount("lu-select-input", "SelectInput", { options, size: "compact" });
    expect(c.hasAttribute("compact")).toBe(true);
    expect(sel(c).getAttribute("part")).toBe("select");
    const bad = await mount("lu-select-input", "SelectInput", { options, size: "huge" });
    expect(bad.hasAttribute("compact")).toBe(false);
  });
});

describe("fix round 1: labels are untrusted text", () => {
  it("field labels and option labels are cleaned to one line, like the terminal's (no escapes, no bidi, no line breaks)", async () => {
    const dirty = "Re\u202eason\u001b[2J\nline2";
    const form = await mount(
      "lu-form-input",
      "FormInput",
      {
        fields: [
          { name: "a", label: dirty, type: "select", options: [{ value: "x", label: dirty }] },
        ],
      },
      () => undefined
    );
    const text = [...root(form).querySelectorAll("label, option")].map((n) => n.textContent);
    for (const bad of ["\u202e", "\u001b", "\n"]) expect(text.join("|")).not.toContain(bad);
    expect(text).toContain("Reason[2J line2");
    const sel = await mount(
      "lu-select-input",
      "SelectInput",
      { options: [{ value: "x", label: dirty }] },
      () => undefined
    );
    expect([...root(sel).querySelectorAll("option")].map((n) => n.textContent)).toContain(
      "Reason[2J line2"
    );
  });
});
