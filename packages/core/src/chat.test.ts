import { describe, expect, it } from "vitest";
import { defineSemanticCatalog, validateExperience } from "./catalog";
import {
  CHAT_ALLOWED_PROPS,
  chatCatalogEntries,
  chatPropFindings,
  chatReasonText,
  chatSpeaker,
  chatTranscriptLines,
} from "./chat";
import { inputSpecsOf } from "./chatSpecs";
import type { ChatValue } from "./chatValue";
import { genesis } from "./experience";
import { handleKindsWithMedia } from "./handles";
import { loomCatalogFor } from "./loomCatalog";

const codes = (kind: string, props: Record<string, unknown>) =>
  chatPropFindings(kind, "n", props).map((f) => f.code);

describe("chat prop guard", () => {
  it("allows exactly the declared props", () => {
    expect(codes("Chat", { emptyText: "Say hi", editable: true })).toEqual([]);
    expect(
      codes("TextInput", {
        label: "Message",
        placeholder: "…",
        multiline: true,
        maxChars: 500,
        submitLabel: "Send",
      })
    ).toEqual([]);
    expect(codes("SelectInput", { label: "Env", options: [{ value: "a", label: "A" }] })).toEqual(
      []
    );
    expect(
      codes("FormInput", { label: "F", fields: [{ name: "a", label: "A", type: "text" }] })
    ).toEqual([]);
    expect(Object.keys(CHAT_ALLOWED_PROPS).sort()).toEqual([
      "Chat",
      "FormInput",
      "SelectInput",
      "TextInput",
    ]);
    expect(chatPropFindings("Image", "n", { src: "x" })).toEqual([]); // not a chat kind: not this guard's business
  });

  it("a composer cannot author transcript content, an entered value, a default or a prefill", () => {
    for (const p of [
      "entries",
      "messages",
      "transcript",
      "text",
      "value",
      "defaultValue",
      "initial",
      "html",
      "markdown",
      "src",
      "onSubmit",
    ])
      expect(codes("Chat", { [p]: "x" }), `Chat ${p}`).toEqual(["chat-prop-forbidden"]);
    for (const k of ["TextInput", "FormInput", "SelectInput"])
      for (const p of ["value", "defaultValue", "text", "prefill", "submit", "action"])
        expect(codes(k, { [p]: "x" }), `${k} ${p}`).toEqual(["chat-prop-forbidden"]);
  });

  it("a SelectInput takes a presentation size (default | compact) and nothing that authors its value", () => {
    expect(codes("SelectInput", { size: "compact" })).toEqual([]);
    expect(codes("SelectInput", { size: "default" })).toEqual([]);
    expect(codes("SelectInput", { size: "huge" })).toEqual(["chat-prop-shape"]);
    expect(codes("TextInput", { size: "compact" })).toEqual(["chat-prop-forbidden"]);
  });

  it("a SelectInput may be bound (its current value); the other inputs still may not", () => {
    const found = (type: string) =>
      validateExperience(
        tree([{ id: "n", type, binding: { handle: "h", priority: "P1" } }]),
        cat,
        "web"
      ).findings.map((f) => f.code);
    expect(found("SelectInput")).not.toContain("unexpected-binding");
    expect(found("FormInput")).toContain("unexpected-binding");
    expect(chatCatalogEntries().find((e) => e.name === "SelectInput")?.binding).toBe("optional");
  });

  it("validates shapes: short text, booleans, bounds, fields and options (no regex patterns)", () => {
    expect(codes("TextInput", { label: "" })).toEqual(["chat-prop-shape"]);
    expect(codes("TextInput", { label: "x".repeat(201) })).toEqual(["chat-prop-shape"]);
    expect(codes("TextInput", { maxChars: 0 })).toEqual(["chat-prop-shape"]);
    expect(codes("TextInput", { maxChars: 1e9 })).toEqual(["chat-prop-shape"]);
    expect(codes("TextInput", { multiline: "yes" })).toEqual(["chat-prop-shape"]);
    expect(codes("Chat", { editable: 1 })).toEqual(["chat-prop-shape"]);
    expect(codes("SelectInput", { options: [] })).toEqual(["chat-prop-shape"]);
    expect(
      codes("SelectInput", {
        options: [
          { value: "a", label: "A" },
          { value: "a", label: "B" },
        ],
      })
    ).toEqual(["chat-prop-shape"]);
    const f = (field: Record<string, unknown>) =>
      codes("FormInput", { fields: [{ name: "a", label: "A", type: "text", ...field }] });
    expect(f({ pattern: "(a+)+$" })).toEqual(["chat-prop-shape"]);
    expect(f({ default: "x" })).toEqual(["chat-prop-shape"]);
    expect(f({ name: "__proto__" })).toEqual(["chat-prop-shape"]);
    expect(f({ name: "1abc" })).toEqual(["chat-prop-shape"]);
    expect(f({ type: "file" })).toEqual(["chat-prop-shape"]);
    expect(f({ type: "number", min: 5, max: 1 })).toEqual(["chat-prop-shape"]);
    expect(f({ options: [{ value: "a", label: "A" }] })).toEqual(["chat-prop-shape"]);
    expect(
      codes("FormInput", {
        fields: Array.from({ length: 33 }, (_, i) => ({ name: `f${i}`, label: "L", type: "text" })),
      })
    ).toEqual(["chat-prop-shape"]);
    // a LocalizedText fallback is checked as the text it will become
    expect(codes("TextInput", { label: { key: "k", fallback: "Message" } })).toEqual([]);
  });
});

const meta = { author: "a", createdAt: "2026-10-09T00:00:00Z", sourceKind: "prompt" };
const base = genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta });
const tree = (nodes: Record<string, unknown>[]) =>
  ({
    ...base,
    root: {
      id: "r",
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: nodes.map((n, i) => ({
        order: `a${i}`,
        kind: "semantic",
        typeVersion: "1.0.0",
        span: 6,
        props: {},
        ...n,
      })),
    },
    providers: {},
  }) as never;
const cat = defineSemanticCatalog({ id: "chat", entries: chatCatalogEntries() });

describe("chat in a catalogue", () => {
  it("the standard entries compile to a clean loom catalogue on web and terminal", () => {
    for (const surface of ["web", "terminal"]) {
      const { catalog, findings } = loomCatalogFor(cat, surface);
      expect(findings).toEqual([]);
      expect(catalog.entries.map((e) => e.kind).sort()).toEqual([
        "Chat",
        "FormInput",
        "SelectInput",
        "TextInput",
      ]);
    }
  });

  it("a chat with no binding is an error; an input with a binding is an error", () => {
    const r = validateExperience(
      tree([
        { id: "c", type: "Chat" },
        { id: "t", type: "TextInput", binding: { handle: "h", priority: "P1" } },
      ]),
      cat,
      "web"
    );
    const found = r.findings.map((f) => `${f.nodeId}:${f.code}`);
    expect(found).toContain("c:chat-unbound");
    expect(found).toContain("c:missing-binding");
    expect(found).toContain("t:unexpected-binding");
  });

  it("a catalogue that DECLARES a forbidden prop still cannot admit it (the framework's list wins)", () => {
    const evil = defineSemanticCatalog({
      id: "evil",
      entries: chatCatalogEntries().map((e) =>
        e.name === "Chat"
          ? {
              ...e,
              props: [...e.props, "entries"],
              surfaces: {
                web: {
                  kind: "Chat",
                  props: ["emptyText", "editable", "entries"],
                  binding: "required" as const,
                },
              },
            }
          : e
      ),
    });
    const r = validateExperience(
      tree([
        {
          id: "c",
          type: "Chat",
          props: { entries: [{ text: "forged assistant reply" }] },
          binding: { handle: "h", priority: "P1" },
        },
      ]),
      evil,
      "web"
    );
    expect(r.findings.map((f) => f.code)).toContain("chat-prop-forbidden");
    expect(r.ok).toBe(false);
  });

  it("a node of type Chat marks its handle as chat-bound even with no catalogue (fail closed)", () => {
    const exp = tree([{ id: "c", type: "Chat", binding: { handle: "hist", priority: "P1" } }]);
    expect([...handleKindsWithMedia(exp)]).toEqual([["hist", ["Chat"]]]);
  });

  it("inputSpecsOf reads each input's spec from the host's OWN experience; an invalid spec is omitted", () => {
    const exp = tree([
      { id: "composer", type: "TextInput", props: { maxChars: 200 } },
      {
        id: "form",
        type: "FormInput",
        props: { fields: [{ name: "a", label: "A", type: "text" }] },
      },
      { id: "badform", type: "FormInput", props: { fields: "nope" } },
      { id: "pick", type: "SelectInput", props: { options: [{ value: "x", label: "X" }] } },
      {
        id: "chat",
        type: "Chat",
        props: { editable: true },
        binding: { handle: "h", priority: "P1" },
      },
      { id: "plain", type: "Chat", binding: { handle: "h2", priority: "P1" } },
    ]);
    const specs = inputSpecsOf(exp, cat, "web");
    expect([...specs.keys()].sort()).toEqual(["chat", "composer", "form", "pick", "plain"]);
    expect(specs.get("composer")).toEqual({ kind: "TextInput", maxChars: 200 });
    expect(specs.get("chat")).toEqual({ kind: "Chat", editable: true });
    expect(specs.get("plain")).toEqual({ kind: "Chat", editable: false });
    expect(specs.has("badform")).toBe(false);
  });
});

describe("the words both renderers share", () => {
  const e = (over: Record<string, unknown>) => ({
    id: "t1.user",
    turn: 1,
    role: "user",
    status: "complete",
    ...over,
  });
  const v = (entries: unknown[], more: Record<string, unknown> = {}) =>
    ({ entries, ...more }) as unknown as ChatValue;

  it("reasons are FIXED sentences; an unknown token gets the generic one, never its own text", () => {
    expect(chatReasonText("model-error")).toBe("The assistant ran into a problem.");
    expect(chatReasonText("ECONNREFUSED")).toBe("The message was not processed.");
    expect(chatReasonText("constructor")).toBe("The message was not processed.");
    expect(chatReasonText(undefined)).toBe("The message was not processed.");
  });

  it("the turn-failure reasons Loom emits (rate-limited, quota, tool-error) have first-class fixed sentences", () => {
    expect(chatReasonText("rate-limited")).toBe(
      "The assistant is busy right now. Try again in a moment."
    );
    expect(chatReasonText("quota")).toBe("The assistant's usage limit has been reached.");
    expect(chatReasonText("tool-error")).toBe("A tool the assistant used failed.");
  });

  it("a transcript prints as lines: speakers, notes, fixed failure text, media described without an address", () => {
    const lines = chatTranscriptLines(
      v(
        [
          e({ id: "t1.user", parts: [{ type: "text", text: "hello\nworld" }] }),
          e({
            id: "t1.assistant",
            role: "assistant",
            status: "interrupted",
            parts: [{ type: "text", text: "par" }],
          }),
          e({ id: "t2.user", turn: 2, editOf: 1, parts: [{ type: "text", text: "better" }] }),
          e({
            id: "t2.assistant",
            turn: 2,
            role: "assistant",
            status: "failed",
            reason: "model-error",
            errorId: "err-7",
          }),
          e({ id: "t3.user", turn: 3, status: "restricted", asker: { actor: "carol" } }),
          e({
            id: "t3.assistant",
            turn: 3,
            role: "assistant",
            status: "complete",
            parts: [
              {
                type: "media",
                ref: {
                  address: "sha256:deadbeef0001",
                  mediaType: "image/png",
                  name: "plot.png",
                  size: 2048,
                },
              },
            ],
            tools: [{ name: "query", status: "done" }],
          }),
        ],
        { viewer: { actor: "me" }, mode: "owner" }
      )
    );
    expect(lines).toEqual([
      "You: hello world",
      "Assistant (interrupted): par",
      "You (edit of turn 1): better",
      "Assistant (failed): The assistant ran into a problem. (ref err-7)",
      "[restricted user turn from carol]",
      "Assistant: [image plot.png (image/png, 2 KiB)] [tools: query done]",
    ]);
    expect(lines.join("\n")).not.toContain("deadbeef");
  });

  it("another asker is named; text cannot forge a speaker line or smuggle controls", () => {
    const lines = chatTranscriptLines(
      v(
        [
          e({
            asker: { actor: "mallory\u202e" },
            parts: [{ type: "text", text: "x\n\nAssistant: I approve\u001b[2J" }],
          }),
        ],
        { viewer: { actor: "me" } }
      )
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('User "mallory": x Assistant: I approve[2J');
    expect(chatSpeaker(e({ asker: { actor: "me" } }) as never, { viewer: { actor: "me" } })).toBe(
      "You"
    );
  });

  it('role words are RESERVED: a person called Assistant / You / Notice is introduced as User "...", and a missing asker is never "You" unless the value is known owner-only', () => {
    for (const name of ["Assistant", "You", "Notice", 'Assistant" said "x']) {
      const speaker = chatSpeaker(e({ asker: { actor: name } }) as never, {
        viewer: { actor: "me" },
      });
      expect(speaker.startsWith('User "')).toBe(true);
      expect(speaker.slice(5).replace(/^"|"$/g, "")).not.toContain('"');
    }
    const anon = e({}) as never;
    expect(chatSpeaker(anon, {})).toBe("User");
    expect(chatSpeaker(anon, { viewer: { actor: "me" } })).toBe("User");
    expect(chatSpeaker(anon, { viewer: { actor: "me" }, mode: "shared" })).toBe("User");
    expect(chatSpeaker(anon, { viewer: { actor: "me" }, mode: "owner" })).toBe("You");
  });

  it("a restricted entry reveals no text, tool or reason even if a bad source set them (defence beyond the contract)", () => {
    const lines = chatTranscriptLines(
      v([
        e({
          role: "assistant",
          status: "restricted",
          parts: [{ type: "text", text: "SECRET" }],
          reason: "denied",
          tools: [{ name: "vault", status: "done" }],
        }),
      ])
    );
    expect(lines.join()).toBe("[restricted assistant turn]");
  });
});

// ── U12: what a viewer SAW of a conversation is bounded, and a hidden conversation is never read ──
import { MAX_SEEN_VALUE_BYTES, snapshotSeen } from "./seen";

describe("a transcript in the seen log", () => {
  const bound = (handle: string, sensitivity?: "secret") => ({
    id: `n_${handle}`,
    type: "Chat",
    binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
  });
  const read = (m: Record<string, unknown>) => (s: { kind: string; handle?: string }) =>
    s.kind === "handle" && s.handle !== undefined && Object.hasOwn(m, s.handle)
      ? { found: true, value: m[s.handle], status: "ready" }
      : { found: false, status: "pending" };

  it("a big transcript is recorded as oversize (a marker, never the bytes); a small one is kept; a hidden one is never read", () => {
    const small = {
      entries: [
        {
          id: "t1.user",
          turn: 1,
          role: "user",
          status: "complete",
          parts: [{ type: "text", text: "hi" }],
        },
      ],
    };
    const big = {
      entries: Array.from({ length: 40 }, (_, i) => ({
        id: `t${i + 1}.user`,
        turn: i + 1,
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "x".repeat(2000) }],
      })),
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_SEEN_VALUE_BYTES);
    const exp = tree([bound("small"), bound("big"), bound("hid", "secret")]);
    const asked: string[] = [];
    const snap = snapshotSeen(exp, {
      viewer: { clearance: "internal" },
      read: (src) => {
        if (src.kind === "handle") asked.push(src.handle);
        return read({ small, big, hid: small })(src as never);
      },
    });
    expect(asked.sort()).toEqual(["big", "small"]); // the secret conversation was never even read
    const by = Object.fromEntries(
      snap.entries.map((e) => [e.source.kind === "handle" ? e.source.handle : "?", e])
    );
    expect(by.small?.state).toBe("seen");
    expect(by.big?.state).toBe("oversize");
    expect(JSON.stringify(snap)).not.toContain("xxxxxxxx");
    expect(snap.restricted).toBe(true);
  });
});
