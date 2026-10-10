import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { SELECT_ACTION, SUBMIT_TEXT_ACTION } from "@loom-ui/core/chat-ui";
import { HYDRATION_PROJECTION_ID } from "@loom-ui/hydration/client";
import type { Blueprint, WidgetAction } from "@loom/blueprint-runtime";
import type { HandleEntry, InvokeIntent, MountedRenderer, RendererAdapter } from "./adapter";
import {
  GARBAGE,
  KIND_FIXTURES,
  type KindFixture,
  bound,
  roleLayout,
  unbound,
  viewOf,
} from "./fixtures";

/** Thrown by a check to say the renderer broke the contract. */
export class ConformanceFailure extends Error {}
/** Thrown by a check to say it cannot run against this adapter (reported as a skip). */
export class ConformanceSkip extends Error {}

export interface Check {
  readonly id: string;
  readonly title: string;
  run(adapter: RendererAdapter): Promise<void>;
}

const ESC = String.fromCharCode(27);
const BIDI = "‮";
const must = (ok: boolean, message: string): void => {
  if (!ok) throw new ConformanceFailure(message);
};
const flat = (s: string): string => s.replace(/\s+/g, " ");
const has = (haystack: string, needle: string): boolean => flat(haystack).includes(needle);
const show = (s: string): string => JSON.stringify(flat(s).slice(0, 400));

/** One run's mounts, all disposed when it ends. */
class Session {
  private readonly live: MountedRenderer[] = [];
  readonly actions: WidgetAction[] = [];
  constructor(readonly adapter: RendererAdapter) {}
  async mount(
    blueprint: Blueprint,
    values: Record<string, HandleEntry> = {},
    i18n?: import("@loom-ui/core").LuI18n
  ): Promise<MountedRenderer> {
    const m = await this.adapter.mount(blueprint, {
      values,
      onAction: (a) => {
        this.actions.push(a);
        return { ok: true };
      },
      ...(i18n === undefined ? {} : { i18n }),
    });
    this.live.push(m);
    return m;
  }
  dispose(): void {
    for (const m of this.live.splice(0)) {
      try {
        m.dispose();
      } catch {
        /* a failing dispose is reported by the dispose check, not here */
      }
    }
  }
}

const withSession = async (adapter: RendererAdapter, fn: (s: Session) => Promise<void>) => {
  const s = new Session(adapter);
  try {
    await fn(s);
  } finally {
    s.dispose();
  }
};

const handleOf = (id: string): string => `h-${id}`;
const widgetOf = (f: KindFixture, id = `w-${f.kind}`) =>
  f.value === undefined
    ? unbound(f.kind, id, f.title, f.props)
    : bound(f.kind, id, f.title, handleOf(id), f.props);
const entryOf = (f: KindFixture, id = `w-${f.kind}`): Record<string, HandleEntry> =>
  f.value === undefined ? {} : { [handleOf(id)]: { value: f.value, state: "ready" } };

const checks: Check[] = [];
const check = (id: string, title: string, run: Check["run"]): void => {
  checks.push({ id, title, run });
};

// ── every kind is drawn or visibly refused ─────────────────────────────────────────────────────
check("kinds", "every kind is drawn, or refused where a viewer can see it", (adapter) =>
  withSession(adapter, async (s) => {
    for (const f of KIND_FIXTURES) {
      const m = await s.mount(viewOf([widgetOf(f)]), entryOf(f));
      const out = await m.text();
      for (const g of GARBAGE)
        must(!out.includes(g), `${f.kind}: the surface carries "${g}": ${show(out)}`);
      if (adapter.kinds.includes(f.kind)) {
        for (const n of f.needles)
          must(
            has(out, n),
            `${f.kind}: claimed as drawn but "${n}" is not on the surface: ${show(out)}`
          );
        must(
          has(out, f.title),
          `${f.kind}: its title "${f.title}" is not on the surface: ${show(out)}`
        );
      } else {
        must(
          has(out, f.kind) || has(out, f.title),
          `${f.kind}: not in adapter.kinds, so it must be refused visibly (its kind or title on the surface), not dropped: ${show(out)}`
        );
      }
    }
  })
);

check("unknown-kind", "a kind nobody registered is marked, never silently dropped", (adapter) =>
  withSession(adapter, async (s) => {
    const w = bound("NoSuchKindAnywhere", "u1", "Mystery title", "h-u1");
    const m = await s.mount(viewOf([w]), { "h-u1": { value: { a: 1 }, state: "ready" } });
    const out = await m.text();
    must(
      has(out, "NoSuchKindAnywhere") || has(out, "Mystery title"),
      `an unregistered kind left no trace on the surface: ${show(out)}`
    );
  })
);

// ── the status matrix: what each delivery state may show ───────────────────────────────────────
check("status-matrix", "loading, error, empty and stale each show only what they may", (adapter) =>
  withSession(adapter, async (s) => {
    const VALUE = "secret-reading-31337";
    const w = bound("StatusBadge", "sb", "Phase badge", "h-sb");
    const m = await s.mount(viewOf([w]));
    const at = async (e: HandleEntry): Promise<string> => {
      await m.set("h-sb", e);
      return await m.text();
    };
    const loading = await at({});
    must(!has(loading, VALUE), "loading: shows a value that was never delivered");
    must(has(loading, "Phase badge"), `loading: the widget is gone, not loading: ${show(loading)}`);
    const ready = await at({ value: VALUE, state: "ready" });
    must(has(ready, VALUE), `ready: the value is not shown: ${show(ready)}`);
    const stale = await at({ value: VALUE, state: "stale", message: "behind-by-9" });
    must(has(stale, VALUE), `stale: the last value must stay on screen: ${show(stale)}`);
    const error = await at({ value: VALUE, state: "error", message: "boom-reason-42" });
    must(has(error, "boom-reason-42"), `error: the finding is not shown: ${show(error)}`);
    must(!has(error, VALUE), `error: shows a value beside an error: ${show(error)}`);
    const empty = await at({ value: VALUE, state: "empty", message: "nothing-here-7" });
    must(!has(empty, VALUE), `empty: shows a value beside empty: ${show(empty)}`);
    const back = await at({ value: VALUE, state: "ready" });
    must(has(back, VALUE), `ready after error: the view did not recover: ${show(back)}`);
  })
);

// ── live data ──────────────────────────────────────────────────────────────────────────────────
check("live-update", "a delivered change replaces what is shown, and dispose stops it", (adapter) =>
  withSession(adapter, async (s) => {
    const w = bound("StatusBadge", "sb", "Phase", "h-sb");
    const m = await s.mount(viewOf([w]), { "h-sb": { value: "first-phase", state: "ready" } });
    must(has(await m.text(), "first-phase"), "the initial value is not shown");
    await m.set("h-sb", { value: "second-phase", state: "ready" });
    const out = await m.text();
    must(has(out, "second-phase"), `a new value did not land: ${show(out)}`);
    must(!has(out, "first-phase"), `the old value is still shown: ${show(out)}`);
    m.dispose();
    let threw = false;
    try {
      await m.set("h-sb", { value: "after-dispose", state: "ready" });
    } catch {
      threw = true;
    }
    must(!threw, "set() after dispose() threw");
    must(!has(await m.text(), "after-dispose"), "a disposed view kept following the data");
  })
);

check(
  "incremental-update",
  "update(next) lands a revised Blueprint and keeps the live data",
  (adapter) =>
    withSession(adapter, async (s) => {
      if (adapter.capabilities?.update !== true || !adapter.kinds.includes("Note"))
        throw new ConformanceSkip("adapter declares no incremental update");
      const badge = bound("StatusBadge", "sb", "Phase", "h-sb");
      const m = await s.mount(viewOf([badge]), { "h-sb": { value: "kept-phase", state: "ready" } });
      const note = unbound("Note", "n1", "Added", { text: "added-by-update" });
      await m.update?.(viewOf([badge, note]));
      const out = await m.text();
      must(
        has(out, "added-by-update"),
        `the revised Blueprint's new widget is missing: ${show(out)}`
      );
      must(has(out, "kept-phase"), `update dropped the kept widget's value: ${show(out)}`);
      await m.update?.(viewOf([note]));
      const gone = await m.text();
      must(!has(gone, "kept-phase"), `a removed widget is still shown: ${show(gone)}`);
      await m.set("h-sb", { value: "ghost-phase", state: "ready" });
      must(!has(await m.text(), "ghost-phase"), "a removed widget came back from the data");
    })
);

// ── restricted nodes never leak ────────────────────────────────────────────────────────────────
const PAY = 987_654;
function restrictedFixture(surface: string, adapter: RendererAdapter) {
  const catalog = defineSemanticCatalog({
    id: "conformance",
    entries: [
      {
        name: "Figure",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: { [surface]: { kind: "MetricCard", props: [], binding: "required" } },
      },
      {
        name: "Explainer",
        version: "1.0.0",
        props: ["text"],
        binding: "none",
        surfaces: { [surface]: { kind: "Note", props: ["text"], binding: "none" } },
      },
    ],
  });
  const g = genesis({
    experienceId: "conformance",
    intent: { objective: "payroll review", source: "user" },
    meta: { author: "kit", createdAt: "2026-10-05T00:00:00Z", sourceKind: "prompt" },
  });
  const figure = (id: string, sensitive: boolean): SemanticNode => ({
    id,
    order: id,
    kind: "semantic",
    type: "Figure",
    typeVersion: "1.0.0",
    span: 6,
    label: { key: id, fallback: `Label ${id}` },
    props: {},
    binding: {
      handle: `h-${id}`,
      priority: "P0",
      ...(sensitive ? { sensitivity: "sensitive" } : {}),
    },
  });
  const provider = (handle: string) => ({
    handle,
    executionGraph: [],
    reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
    outputShapeHash: "sha256:o",
    cachePolicy: { ttlSeconds: 60, scope: "global" as const },
  });
  const exp = {
    ...g,
    versionHash: "sha256:conformance",
    root: {
      ...(g.root as ContainerNode),
      children: [figure("pay", true), figure("pub", false)],
    },
    providers: { "h-pay": provider("h-pay"), "h-pub": provider("h-pub") },
  };
  const compileFor = (clearance: string) => {
    const r = compile(exp, {
      surface,
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: "1.0.0",
      viewer: { clearance },
    } as never);
    must(r.ok, `the kit's own fixture did not compile for surface "${adapter.surface}"`);
    return r.blueprint;
  };
  return { compileFor };
}

check(
  "restricted",
  "a restricted node shows a bare placeholder and none of what it replaced",
  (adapter) =>
    withSession(adapter, async (s) => {
      const { compileFor } = restrictedFixture(adapter.surface, adapter);
      // The store HOLDS the value: a renderer is not the enforcement point, but it must not go
      // looking for what the placeholder replaced.
      const values: Record<string, HandleEntry> = {
        "h-pay": { value: PAY, state: "ready" },
        "h-pub": { value: 424_242, state: "ready" },
      };
      const redacted = await (await s.mount(compileFor("internal"), values)).text();
      must(
        has(redacted, "Restricted"),
        `no restricted placeholder on the surface: ${show(redacted)}`
      );
      for (const leak of [String(PAY), "987,654", "Label pay", "h-pay"])
        must(!has(redacted, leak), `a restricted node leaked "${leak}": ${show(redacted)}`);
      must(
        has(redacted, "424242") || has(redacted, "424,242"),
        `the visible sibling vanished: ${show(redacted)}`
      );
      // Positive control: the same data for a cleared viewer IS shown, so the redaction above is the
      // compile's doing and the leak check is not vacuous.
      const cleared = await (await s.mount(compileFor("sensitive"), values)).text();
      must(
        has(cleared, String(PAY)) || has(cleared, "987,654"),
        `control: a cleared viewer's value is not shown: ${show(cleared)}`
      );
    })
);

// ── containers ─────────────────────────────────────────────────────────────────────────────────
check(
  "container-roles",
  "a container role the renderer does not know is the plain titled container",
  (adapter) =>
    withSession(adapter, async (s) => {
      for (const role of ["tabs", "stepper", "app-defined-role"]) {
        const a = bound("StatusBadge", "ca", "Panel A badge", "h-ca");
        const b = bound("StatusBadge", "cb", "Panel B badge", "h-cb");
        const bp = viewOf([
          roleLayout(role, "First panel", [a]),
          roleLayout(role, "Second panel", [b]),
        ]);
        const m = await s.mount(bp, {
          "h-ca": { value: "value-in-a", state: "ready" },
          "h-cb": { value: "value-in-b", state: "ready" },
        });
        const out = await m.text();
        for (const n of ["First panel", "value-in-a", "Second panel", "value-in-b"])
          must(has(out, n), `role "${role}": "${n}" is not reachable: ${show(out)}`);
        const at = (n: string): number => flat(out).indexOf(n);
        must(
          at("First panel") < at("value-in-a") &&
            at("value-in-a") < at("Second panel") &&
            at("Second panel") < at("value-in-b"),
          `role "${role}": panels are out of reading order: ${show(out)}`
        );
      }
    })
);

// ── empty states ───────────────────────────────────────────────────────────────────────────────
check("empty-states", "an empty table, chart or transcript still says what it is", (adapter) =>
  withSession(adapter, async (s) => {
    const cases: Array<[string, unknown]> = [
      ["Table", { columns: ["db"], rows: [] }],
      ["BarChart", { bars: [] }],
      ["Chat", { entries: [], mode: "owner" }],
    ];
    for (const [kind, value] of cases) {
      if (!adapter.kinds.includes(kind)) continue;
      const w = bound(kind, `e-${kind}`, `Empty ${kind}`, `h-e-${kind}`);
      const m = await s.mount(viewOf([w]), { [`h-e-${kind}`]: { value, state: "ready" } });
      const out = await m.text();
      must(has(out, `Empty ${kind}`), `${kind}: an empty value dropped the widget: ${show(out)}`);
      for (const g of GARBAGE)
        must(!out.includes(g), `${kind}: empty state carries "${g}": ${show(out)}`);
    }
  })
);

// ── untrusted text ─────────────────────────────────────────────────────────────────────────────
// Every place untrusted text can enter a surface gets the SAME hostile string: markup, an ANSI
// CSI, a C1 CSI, OSC 8 (hyperlink) and OSC 52 (clipboard) strings closed by BEL, CR, backspace,
// NUL, a bidi isolate, a zero-width space and a bidi override. A surface that interprets control
// characters must carry none of them; every surface must show the markup as literal characters.
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const HOSTILE = [
  "Q<b>m</b>",
  `${ESC}[2J`,
  "\u009b31m",
  `${ESC}]8;;http://evil.example${BEL}link${ESC}]8;;${BEL}`,
  `${ESC}]52;c;cGF5${BEL}`,
  "\r\b",
  NUL,
  "\u2066",
  "\u200b",
  BIDI,
  "z",
].join("");
const FORBIDDEN: ReadonlyArray<[string, string]> = [
  ["an escape character", ESC],
  ["a C1 control (0x9b)", "\u009b"],
  ["a BEL", BEL],
  ["a carriage return", "\r"],
  ["a backspace", "\b"],
  ["a NUL", NUL],
  ["a bidi isolate", "\u2066"],
  ["a zero-width space", "\u200b"],
  ["a bidi override", BIDI],
];
const MESSAGE_KEYS = [
  "lu.approval.approve",
  "lu.approval.reject",
  "lu.input.choose",
  "lu.input.message",
  "lu.chat.who.assistant",
  "lu.chat.who.user",
  "lu.empty.noData",
  "lu.state.loading",
];

check(
  "untrusted-text",
  "untrusted text is shown as text: markup literal, control sequences never interpreted",
  (adapter) =>
    withSession(adapter, async (s) => {
      const strict = adapter.capabilities?.interpretsControlCharacters === true;
      // `shown: false` = the kind need not draw this text at all (a column header, say), but if it
      // does, it must not carry a control.
      const verify = (where: string, out: string, shown = true): void => {
        must(
          !shown || has(out, "Q<b>m</b>"),
          `${where}: markup in a text was not shown literally (or the text vanished): ${show(out)}`
        );
        if (strict)
          for (const [name, ch] of FORBIDDEN)
            must(!out.includes(ch), `${where}: ${name} reached the surface: ${show(out)}`);
      };
      const probe = async (
        where: string,
        kinds: readonly string[],
        view: () => ReturnType<typeof viewOf>,
        values: Record<string, HandleEntry> = {},
        i18n?: import("@loom-ui/core").LuI18n,
        shown = true
      ): Promise<void> => {
        if (!kinds.every((k) => adapter.kinds.includes(k))) return;
        verify(where, await (await s.mount(view(), values, i18n)).text(), shown);
      };
      const ready = (h: string, value: unknown): Record<string, HandleEntry> => ({
        [h]: { value, state: "ready" },
      });

      await probe("Note text", ["Note"], () =>
        viewOf([unbound("Note", "n", "Probe", { text: HOSTILE })])
      );
      await probe("Note title", ["Note"], () =>
        viewOf([unbound("Note", "n", HOSTILE, { text: "body" })])
      );
      await probe("view title", ["Note"], () =>
        viewOf([unbound("Note", "n", "Probe", { text: "body" })], HOSTILE)
      );
      await probe("container heading", ["Note"], () =>
        viewOf([roleLayout("tabs", HOSTILE, [unbound("Note", "n", "Probe", { text: "body" })])])
      );
      await probe(
        "Table cell",
        ["Table"],
        () => viewOf([bound("Table", "t", "Probe", "h-t")]),
        ready("h-t", { columns: ["c"], rows: [[HOSTILE]] })
      );
      await probe(
        "Table column",
        ["Table"],
        () => viewOf([bound("Table", "t", "Probe", "h-t")]),
        ready("h-t", { columns: [HOSTILE], rows: [["x"]] }),
        undefined,
        false
      );
      await probe(
        "StatusCard headline",
        ["StatusCard"],
        () => viewOf([bound("StatusCard", "c", "Probe", "h-c")]),
        ready("h-c", { level: "ok", headline: HOSTILE })
      );
      await probe(
        "BarChart label",
        ["BarChart"],
        () => viewOf([bound("BarChart", "b", "Probe", "h-b")]),
        ready("h-b", { bars: [{ label: HOSTILE, value: 3 }] })
      );
      await probe(
        "error message",
        ["StatusBadge"],
        () => viewOf([bound("StatusBadge", "e", "Probe", "h-e")]),
        { "h-e": { state: "error", message: HOSTILE } }
      );
      await probe(
        "media name",
        ["Image"],
        () => viewOf([bound("Image", "i", "Probe", "h-i")]),
        ready("h-i", { address: ADDR, mediaType: "image/png", size: 2048, name: HOSTILE })
      );
      await probe("input label", ["TextInput"], () =>
        viewOf([unbound("TextInput", "ti", "Probe", { label: HOSTILE })])
      );
      await probe("select label and option labels", ["SelectInput"], () =>
        viewOf([
          unbound("SelectInput", "sel", "Probe", {
            label: HOSTILE,
            options: [
              { value: "a", label: HOSTILE },
              { value: "b", label: "Beta" },
            ],
          }),
        ])
      );
      await probe(
        "chat turn",
        ["Chat"],
        () => viewOf([bound("Chat", "chat", "Chat", "h-chat")]),
        ready("h-chat", {
          mode: "owner",
          entries: [
            { id: "a", turn: 1, role: "assistant", status: "complete", parts: part(HOSTILE) },
          ],
        })
      );

      // The host's own catalogue words are as untrusted as a title: a translated word can carry
      // anything. An interactive surface draws them in its controls too (an approval pending, a
      // select and a text input with no label of their own, so the fixed words stand in).
      if (adapter.capabilities?.i18n === true) {
        const messages = Object.fromEntries(MESSAGE_KEYS.map((k) => [k, HOSTILE]));
        const kinds = ["ApprovalCard", "SelectInput", "TextInput"].filter((k) =>
          adapter.kinds.includes(k)
        );
        if (kinds.length > 0)
          verify(
            "i18n catalogue word in controls",
            await (
              await s.mount(
                viewOf([
                  ...(kinds.includes("ApprovalCard")
                    ? [bound("ApprovalCard", "appr", "Deploy?", "h-appr")]
                    : []),
                  ...(kinds.includes("SelectInput")
                    ? [
                        unbound("SelectInput", "sel", undefined, {
                          options: [{ value: "a", label: "Alpha" }],
                        }),
                      ]
                    : []),
                  ...(kinds.includes("TextInput") ? [unbound("TextInput", "ti", undefined)] : []),
                ]),
                ready("h-appr", { pending: true }),
                { messages }
              )
            ).text()
          );
        if (adapter.kinds.includes("Chat"))
          verify(
            "i18n catalogue word in a transcript",
            await (
              await s.mount(
                viewOf([bound("Chat", "chat", "Chat", "h-chat")]),
                ready("h-chat", {
                  mode: "owner",
                  entries: [
                    { id: "a", turn: 1, role: "assistant", status: "complete", parts: part("hi") },
                  ],
                }),
                { messages }
              )
            ).text()
          );
        if (adapter.kinds.includes("StatusBadge"))
          verify(
            "i18n catalogue word in a loading row",
            await (
              await s.mount(viewOf([bound("StatusBadge", "sb", "Probe", "h-sb")]), {}, { messages })
            ).text(),
            false
          );
      }
    })
);

// ── media ──────────────────────────────────────────────────────────────────────────────────────
const ADDR = "sha256:0123456789abcdef0123456789abcdef";
check("media-refs", "a media reference is described, and its address is never shown", (adapter) =>
  withSession(adapter, async (s) => {
    const ref = { address: ADDR, mediaType: "image/png", size: 2048, name: "chart.png" };
    const w = bound("Image", "img", "Picture", "h-img");
    const m = await s.mount(viewOf([w]), { "h-img": { value: ref, state: "ready" } });
    const out = await m.text();
    must(!out.includes(ADDR), `the media address is on the surface: ${show(out)}`);
    must(
      !out.includes("0123456789abcdef"),
      `part of the media address is on the surface: ${show(out)}`
    );
    must(
      has(out, "Picture") || has(out, "chart.png") || has(out, "Image"),
      `the media was dropped without a trace: ${show(out)}`
    );
    if (adapter.kinds.includes("Image"))
      must(has(out, "chart.png"), `media is claimed as drawn but not described: ${show(out)}`);
  })
);

// ── chat ───────────────────────────────────────────────────────────────────────────────────────
const part = (t: string) => [{ type: "text" as const, text: t }];
check(
  "chat",
  "a transcript shows complete turns, and a restricted turn only as a placeholder",
  (adapter) =>
    withSession(adapter, async (s) => {
      if (!adapter.kinds.includes("Chat")) throw new ConformanceSkip("adapter does not claim Chat");
      const value = {
        mode: "owner",
        entries: [
          {
            id: "t1.user",
            turn: 1,
            role: "user",
            status: "complete",
            parts: part("hello-from-user"),
          },
          {
            id: "t1.assistant",
            turn: 1,
            role: "assistant",
            status: "complete",
            parts: part("answer-from-assistant"),
          },
          { id: "t2.user", turn: 2, role: "user", status: "restricted", asker: { actor: "carol" } },
        ],
      };
      const w = bound("Chat", "chat", "Support chat", "h-chat");
      const m = await s.mount(viewOf([w]), { "h-chat": { value, state: "ready" } });
      const out = await m.text();
      must(has(out, "hello-from-user"), `a user turn is missing: ${show(out)}`);
      must(has(out, "answer-from-assistant"), `an assistant turn is missing: ${show(out)}`);
      must(has(out, "estricted"), `the restricted turn left no placeholder: ${show(out)}`);
      const at = (n: string): number => flat(out).indexOf(n);
      must(
        at("hello-from-user") < at("answer-from-assistant"),
        `turns are out of order: ${show(out)}`
      );
      // A stray field a source forgot to strip is refused by the contract, and the view says so
      // instead of drawing it.
      await m.set("h-chat", {
        value: { ...value, entries: [{ ...value.entries[0], html: "<b>raw-markup-leak</b>" }] },
        state: "ready",
      });
      const refused = await m.text();
      must(
        !has(refused, "raw-markup-leak"),
        `a field outside the contract reached the surface: ${show(refused)}`
      );
    })
);

// ── i18n ───────────────────────────────────────────────────────────────────────────────────────
check("i18n", "the host's words and locale replace the fixed ones", (adapter) =>
  withSession(adapter, async (s) => {
    if (adapter.capabilities?.i18n !== true) throw new ConformanceSkip("adapter declares no i18n");
    if (adapter.kinds.includes("Chat")) {
      const value = {
        mode: "owner",
        entries: [
          { id: "a", turn: 1, role: "assistant", status: "complete", parts: part("reply-text") },
        ],
      };
      const w = bound("Chat", "chat", "Chat", "h-chat");
      const m = await s.mount(
        viewOf([w]),
        { "h-chat": { value, state: "ready" } },
        { messages: { "lu.chat.who.assistant": "Assistent-X" } }
      );
      const out = await m.text();
      must(has(out, "Assistent-X"), `a host message did not replace the fixed word: ${show(out)}`);
      must(has(out, "reply-text"), `the turn's own text vanished: ${show(out)}`);
    }
    if (adapter.kinds.includes("Kpi")) {
      const w = bound("Kpi", "k", "Kpi", "h-k");
      const m = await s.mount(
        viewOf([w]),
        { "h-k": { value: { value: 1234.5 }, state: "ready" } },
        { locale: "de-DE" }
      );
      const out = await m.text();
      must(has(out, "1.234,5"), `the host's locale did not format the number: ${show(out)}`);
    }
  })
);

// ── actions ────────────────────────────────────────────────────────────────────────────────────
check("actions", "controls emit the WidgetAction shapes every renderer shares", (adapter) =>
  withSession(adapter, async (s) => {
    if (adapter.capabilities?.invoke !== true)
      throw new ConformanceSkip("adapter declares no invoke");
    const drive = async (
      m: MountedRenderer,
      id: string,
      intent: InvokeIntent
    ): Promise<WidgetAction> => {
      const before = s.actions.length;
      await m.invoke?.(id, intent);
      must(
        s.actions.length === before + 1,
        `invoking ${intent.kind} on "${id}" emitted ${s.actions.length - before} actions, not 1`
      );
      return s.actions[before] as WidgetAction;
    };
    const keyOk = (k: unknown): boolean =>
      typeof k === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(k);

    if (adapter.kinds.includes("ApprovalCard")) {
      const w = bound("ApprovalCard", "appr", "Deploy?", "h-appr");
      const m = await s.mount(viewOf([w]), {
        "h-appr": { value: { pending: true }, state: "ready" },
      });
      const approve = await drive(m, "appr", { kind: "approve" });
      must(
        approve.type === "APPROVE" &&
          approve.widgetId === "appr" &&
          (approve.payload as { approved?: unknown } | undefined)?.approved === true,
        `approve: unexpected action ${JSON.stringify(approve)}`
      );
      // A renderer may answer a pending approval once (a repeat is a double-submit), so the other
      // intent is driven on a fresh mount of the same pending approval.
      const m2 = await s.mount(viewOf([w]), {
        "h-appr": { value: { pending: true }, state: "ready" },
      });
      const reject = await drive(m2, "appr", { kind: "reject" });
      must(
        reject.type === "REJECT" &&
          reject.widgetId === "appr" &&
          (reject.payload as { approved?: unknown } | undefined)?.approved === false,
        `reject: unexpected action ${JSON.stringify(reject)}`
      );
    }
    if (adapter.kinds.includes("SelectInput")) {
      const w = unbound("SelectInput", "sel", "Pick", {
        label: "Pick one",
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      });
      const m = await s.mount(viewOf([w]));
      const a = await drive(m, "sel", { kind: "select", value: "beta" });
      const p = a.payload as { value?: unknown; key?: unknown } | undefined;
      must(
        a.type === SELECT_ACTION && a.widgetId === "sel" && p?.value === "beta" && keyOk(p?.key),
        `select: unexpected action ${JSON.stringify(a)}`
      );
    }
    if (adapter.kinds.includes("TextInput")) {
      const w = unbound("TextInput", "txt", "Ask", { label: "Message" });
      const m = await s.mount(viewOf([w]));
      const a = await drive(m, "txt", { kind: "text", text: "hello there" });
      const p = a.payload as { text?: unknown; key?: unknown } | undefined;
      must(
        a.type === SUBMIT_TEXT_ACTION &&
          a.widgetId === "txt" &&
          p?.text === "hello there" &&
          keyOk(p?.key),
        `text: unexpected action ${JSON.stringify(a)}`
      );
    }
  })
);

export const CHECKS: readonly Check[] = checks;
