import type { Blueprint, Widget, WidgetAction } from "@loomwork/blueprint-runtime";
import {
  type ContainerNode,
  REF_OPEN_ACTION,
  type SemanticNode,
  TABLE_TOKEN,
  WIDGET_REF_KINDS,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loomwork/ui-core";
import { SELECT_ACTION, SELECT_MANY_ACTION, SUBMIT_TEXT_ACTION } from "@loomwork/ui-core/chat-ui";
import { HYDRATION_PROJECTION_ID } from "@loomwork/ui-hydration/client";
import type {
  HandleEntry,
  InvokeIntent,
  MountOptions,
  MountedRenderer,
  RendererAdapter,
} from "./adapter";
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
    i18n?: import("@loomwork/ui-core").LuI18n,
    extra: Pick<MountOptions, "chatAccessory" | "unattended"> = {}
  ): Promise<MountedRenderer> {
    const m = await this.adapter.mount(blueprint, {
      values,
      onAction: (a) => {
        this.actions.push(a);
        return { ok: true };
      },
      ...(i18n === undefined ? {} : { i18n }),
      ...extra,
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
  const compileFor = (clearance: string, audience?: "broadcast") => {
    const r = compile(exp, {
      surface,
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: "1.0.0",
      viewer: { clearance },
      ...(audience !== undefined && { audience }),
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

// ── audience: a broadcast surface never shows what it withheld ───────────────────────────────────
check(
  "audience",
  "a widget withheld for the audience shows only the constant redaction marker, whatever it still carries",
  (adapter) =>
    withSession(adapter, async (s) => {
      const { compileFor } = restrictedFixture(adapter.surface, adapter);
      const values: Record<string, HandleEntry> = {
        "h-pay": { value: PAY, state: "ready" },
        "h-pub": { value: 424_242, state: "ready" },
      };
      const LEAKS = [String(PAY), "987,654", "Label pay", "h-pay"];
      // The compile's own broadcast output, for a viewer who is FULLY cleared: the audience, not the
      // viewer, withheld it. The store holds the value; the renderer must not go looking.
      const wall = await (await s.mount(compileFor("secret", "broadcast"), values)).text();
      must(has(wall, "redacted"), `no redaction marker on the broadcast surface: ${show(wall)}`);
      for (const leak of LEAKS)
        must(!has(wall, leak), `a withheld widget leaked "${leak}": ${show(wall)}`);
      must(
        has(wall, "424242") || has(wall, "424,242"),
        `the unclassified sibling vanished: ${show(wall)}`
      );
      // Positive control: the same viewer's own surface shows the value, so the grep is not vacuous.
      const own = await (await s.mount(compileFor("secret"), values)).text();
      must(
        has(own, String(PAY)) || has(own, "987,654"),
        `control: the cleared viewer's own surface does not show the value: ${show(own)}`
      );
      // Defence in depth: a widget carrying `source.redacted` that STILL holds a title, props, a
      // binding to live data and a degrade chain (an unvalidated or forged artifact) draws the
      // marker and none of it. The marker decides before anything else is read.
      if (!adapter.kinds.includes("MetricCard"))
        throw new ConformanceSkip("the forged-widget half needs a MetricCard renderer");
      const forged: Widget = {
        ...bound("MetricCard", "forged", "SECRET-TITLE", "h-pay", { unit: "SECRET-UNIT" }),
        source: {
          type: "SecretType",
          version: "9",
          redacted: true,
          degradedFrom: [{ type: "SecretChain", version: "3" }],
        },
      };
      const out = await (await s.mount(viewOf([forged]), values)).text();
      must(has(out, "redacted"), `a forged redacted widget drew no marker: ${show(out)}`);
      for (const leak of [
        "SECRET-TITLE",
        "SECRET-UNIT",
        "SecretType",
        "SecretChain",
        String(PAY),
        "987,654",
        "MetricCard",
        "h-pay",
      ])
        must(!has(out, leak), `a redacted widget leaked "${leak}": ${show(out)}`);
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
        i18n?: import("@loomwork/ui-core").LuI18n,
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
      // The bound value's label, option label, hint and note are all untrusted text (the option
      // VALUE is a machine word the contract keeps clean, so it is a plain one here). A hint is capped
      // at 40 characters by the value contract, so it gets a short hostile text of its own.
      const HINT = `Q<b>m</b>${ESC}[2J${BEL}${BIDI}`;
      await probe(
        "multi-select label, option label, hint and note",
        ["MultiSelectInput"],
        () => viewOf([bound("MultiSelectInput", "msel", "Probe", "h-msel", { label: HOSTILE })]),
        ready("h-msel", {
          options: [
            { value: "a", label: HOSTILE, hint: HINT },
            { value: "b", label: "Beta" },
          ],
          selected: ["a"],
          note: HOSTILE,
        })
      );
      // A document's text in each format, and its note, are untrusted text like a chat turn: the markup is shown
      // literally and no control sequence is interpreted.
      for (const format of ["markdown", "org", "plain"] as const)
        await probe(
          `Prose ${format} text`,
          ["Prose"],
          () => viewOf([bound("Prose", "pr", "Probe", "h-pr")]),
          ready("h-pr", { format, text: HOSTILE })
        );
      await probe(
        "Prose note",
        ["Prose"],
        () => viewOf([bound("Prose", "pr", "Probe", "h-pr")]),
        ready("h-pr", { format: "plain", text: "body", note: HOSTILE })
      );
      // A diagram's labels are data like a table cell: node, edge and the value's own title.
      await probe(
        "Diagram node label",
        ["Diagram"],
        () => viewOf([bound("Diagram", "dg", "Probe", "h-dg")]),
        ready("h-dg", {
          layout: "network",
          nodes: [
            { id: "a", label: HOSTILE },
            { id: "b", label: "Beta" },
          ],
          edges: [],
        })
      );
      await probe(
        "Diagram edge label",
        ["Diagram"],
        () => viewOf([bound("Diagram", "dg", "Probe", "h-dg")]),
        ready("h-dg", {
          layout: "flow",
          nodes: [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Beta" },
          ],
          edges: [{ from: "a", to: "b", label: HOSTILE }],
        })
      );
      await probe(
        "Diagram title",
        ["Diagram"],
        () => viewOf([bound("Diagram", "dg", "Probe", "h-dg")]),
        ready("h-dg", {
          layout: "network",
          title: HOSTILE,
          nodes: [{ id: "a", label: "Alpha" }],
          edges: [],
        })
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
        const kinds = ["ApprovalCard", "SelectInput", "TextInput", "MultiSelectInput"].filter((k) =>
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
                  ...(kinds.includes("MultiSelectInput")
                    ? [bound("MultiSelectInput", "msel", "Pick", "h-msel")]
                    : []),
                ]),
                {
                  ...ready("h-appr", { pending: true }),
                  ...ready("h-msel", { options: [{ value: "a", label: "Alpha" }], selected: [] }),
                },
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

// ── chat markdown ─────────────────────────────────────────────────────────────────────────────
// An assistant part that says `format: "markdown"` is read as the closed subset core parses (`parseChatMarkdown`), never as
// HTML: markup stays the literal characters, a link keeps its target only when it is http, https or mailto, an image is
// its alt text, a part with no format is never parsed, and a person's turn is never markdown. A surface that draws the
// transcript with `chatTranscriptLines` gets all of it for free; one that draws it itself must pass here.
const MARKDOWN_SOURCE = [
  "Total is **due-in-30** days.",
  "",
  "<b>raw-html-leak</b> &amp; <script>x</script>",
  "",
  "[good-label](https://docs.example/terms) and [evil-label](javascript:alert-sentinel)",
  "",
  "[cc-label](mailto:a@x.example?cc=evil@y.example)",
  "",
  "![alt-sentinel](https://tracker.example/pixel.png)",
  "",
  "- item-one",
  "",
  "```",
  HOSTILE,
  "```",
].join("\n");
const turn = (id: string, n: number, role: string, t: string, format?: string) => ({
  id,
  turn: n,
  role,
  status: "complete",
  parts: [{ type: "text", text: t, ...(format === undefined ? {} : { format }) }],
});
check(
  "chat-markdown",
  "markdown in an assistant reply is drawn as text: html stays literal, only safe links keep a target, an image is its alt text, a part with no format is never parsed",
  (adapter) =>
    withSession(adapter, async (s) => {
      if (!adapter.kinds.includes("Chat")) throw new ConformanceSkip("adapter does not claim Chat");
      const value = {
        mode: "owner",
        entries: [
          turn("t1.user", 1, "user", "user-plain **kept**"),
          turn("t1.assistant", 1, "assistant", MARKDOWN_SOURCE, "markdown"),
          turn("t2.assistant", 2, "assistant", "**stay-literal** [x](https://plain.example)"),
        ],
      };
      const m = await s.mount(viewOf([bound("Chat", "chat", "Support chat", "h-chat")]), {
        "h-chat": { value, state: "ready" },
      });
      const out = await m.text();
      must(has(out, "due-in-30") && has(out, "item-one"), `markdown text is missing: ${show(out)}`);
      must(out.includes("<b>raw-html-leak</b>"), `html was interpreted or dropped: ${show(out)}`);
      must(
        !out.includes("javascript:"),
        `an address outside the allowlist reached the surface: ${show(out)}`
      );
      must(
        has(out, "cc-label") && !out.includes("evil@y.example"),
        `a mailto that adds a recipient was drawn as a link (or its label was lost): ${show(out)}`
      );
      must(has(out, "evil-label"), `the label of a refused link was dropped: ${show(out)}`);
      must(
        has(out, "good-label") && has(out, "docs.example/terms"),
        `a safe link lost its label or its target: ${show(out)}`
      );
      must(
        has(out, "alt-sentinel") && !out.includes("tracker.example"),
        `an image address reached the surface (or its alt text was lost): ${show(out)}`
      );
      for (const [what, ch] of FORBIDDEN)
        must(!out.includes(ch), `${what} reached the surface through a markdown code block`);
      must(
        has(out, "**stay-literal**") && has(out, "[x](https://plain.example)"),
        `a part with no format was parsed: ${show(out)}`
      );
      must(has(out, "user-plain **kept**"), `a person's turn was altered: ${show(out)}`);
      if (adapter.capabilities?.chatMarkdown === true)
        must(
          !out.includes("[good-label]") && !out.includes("```"),
          `the adapter claims markdown but shows its source: ${show(out)}`
        );
      // A person's own turn is never markdown: the contract refuses it, and the view says so instead of drawing it.
      await m.set("h-chat", {
        value: {
          mode: "owner",
          entries: [turn("t1.user", 1, "user", "user-md-refused", "markdown")],
        },
        state: "ready",
      });
      const refused = await m.text();
      must(
        !has(refused, "user-md-refused"),
        `a person's turn was drawn as markdown: ${show(refused)}`
      );
    })
);

// ── chat entry accessories ─────────────────────────────────────────────────────────────────────
check(
  "chat-entry-accessory",
  "host content under a transcript entry is drawn with that entry, after its text, kept across updates, and never under a restricted entry",
  (adapter) =>
    withSession(adapter, async (s) => {
      if (!adapter.kinds.includes("Chat")) throw new ConformanceSkip("adapter does not claim Chat");
      const claims = adapter.capabilities?.chatEntryAccessory === true;
      const entries = (t3: string, t3Status: string) => [
        turn("t1.user", 1, "user", "question-one"),
        turn("t1.assistant", 1, "assistant", "answer-one"),
        { id: "t2.assistant", turn: 2, role: "assistant", status: "restricted" },
        { ...turn("t3.assistant", 3, "assistant", t3), status: t3Status },
      ];
      const asked: string[] = [];
      const m = await s.mount(
        viewOf([bound("Chat", "chat", "Support chat", "h-chat")]),
        {
          "h-chat": {
            value: { mode: "owner", entries: entries("partial", "streaming") },
            state: "ready",
          },
        },
        undefined,
        claims
          ? {
              chatAccessory: (e) => {
                asked.push(`${e.id}:${e.status}`);
                return e.role === "assistant" ? `accessory-${e.id}` : null;
              },
            }
          : {}
      );
      const out = await m.text();
      must(
        has(out, "answer-one") && has(out, "question-one"),
        `the transcript is not drawn: ${show(out)}`
      );
      if (!claims) return; // a surface without the seam: the transcript above is all it owes
      must(
        !has(out, "accessory-t2.assistant") && !asked.some((a) => a.startsWith("t2.assistant")),
        `a restricted entry was asked for or drew an accessory: ${show(out)}`
      );
      must(!has(out, "accessory-t1.user"), `a null accessory drew something: ${show(out)}`);
      const flatOut = flat(out);
      const at = (n: string): number => flatOut.indexOf(n);
      must(
        at("accessory-t1.assistant") > at("answer-one") &&
          at("accessory-t1.assistant") < at("partial"),
        `an accessory is not with its entry, after the entry's text: ${show(out)}`
      );
      await m.set("h-chat", {
        value: { mode: "owner", entries: entries("partial and done", "complete") },
        state: "ready",
      });
      const after = await m.text();
      must(
        has(after, "accessory-t1.assistant") && has(after, "accessory-t3.assistant"),
        `an accessory was lost across an update: ${show(after)}`
      );
      must(
        asked.includes("t3.assistant:complete"),
        `a settled entry was not asked again for its new status: ${JSON.stringify(asked)}`
      );
    })
);

// ── time format ────────────────────────────────────────────────────────────────────────────────
check(
  "time-format",
  "a declared timeFormat labels the time axis: each period as written, once, in its zone",
  (adapter) =>
    withSession(adapter, async (s) => {
      // A surface that draws no TimeSeries owes nothing here (as the i18n check treats its kinds).
      if (!adapter.kinds.includes("TimeSeries")) return;
      const claims = adapter.capabilities?.timeAxisLabels === true;
      const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
      const series = (timestamps: readonly string[]) => [
        {
          label: "trend-series",
          points: timestamps.map((timestamp, i) => ({ timestamp, value: i })),
        },
      ];
      const draw = async (value: unknown, i18n?: import("@loomwork/ui-core").LuI18n) =>
        (
          await s.mount(
            viewOf([bound("TimeSeries", "ts", "Trend", "h-ts")]),
            { "h-ts": { value, state: "ready" } },
            i18n
          )
        ).text();
      const out = await draw({ timeFormat: { granularity: "quarter" }, series: series(months) });
      must(has(out, "trend-series"), `a value declaring a timeFormat was not drawn: ${show(out)}`);
      if (!claims) return; // a surface that draws no time labels owes only the above
      for (const q of ["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]) {
        const n = flat(out).split(q).length - 1;
        must(n === 1, `"${q}" is labelled ${n} times, not once: ${show(out)}`);
      }
      must(!has(out, "2025"), `a period moved to the previous year: ${show(out)}`);
      // A named zone moves the period: 03:00Z on Feb 1 is still January in New York.
      const zoned = await draw({
        timeFormat: { granularity: "month", timeZone: "America/New_York" },
        series: series(["2026-02-01T03:00:00Z", "2026-03-01T12:00:00Z"]),
      });
      must(
        has(zoned, "Jan 2026") && !has(zoned, "Feb 2026"),
        `the declared timeZone was not applied: ${show(zoned)}`
      );
      if (adapter.capabilities?.i18n === true) {
        const words = await draw(
          { timeFormat: { granularity: "quarter" }, series: series(["2026-01", "2026-04"]) },
          { messages: { "lu.time.quarter": "Quartal-{n}-{year}" } }
        );
        must(
          has(words, "Quartal-1-2026"),
          `the host's word did not label the quarter: ${show(words)}`
        );
      }
    })
);

// ── diagram ────────────────────────────────────────────────────────────────────────────────────
check(
  "diagram",
  "a Diagram draws every node in the outline's order, and a value that breaks a rule is the error state",
  (adapter) =>
    withSession(adapter, async (s) => {
      // A surface that does not claim the kind owes nothing here (the `kinds` check covers its refusal).
      if (!adapter.kinds.includes("Diagram")) return;
      const node = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        label: `zq-${id}`,
        ...extra,
      });
      const draw = async (value: unknown): Promise<string> =>
        (
          await s.mount(viewOf([bound("Diagram", "dg", "Probe diagram", "h-dg")]), {
            "h-dg": { value, state: "ready" },
          })
        ).text();
      /** Every label is on the surface, in this order (by first appearance). */
      const inOrder = (out: string, labels: readonly string[], where: string): void => {
        let from = 0;
        for (const label of labels) {
          const at = flat(out).indexOf(label, from);
          must(at >= 0, `${where}: "${label}" is missing, or out of order: ${show(out)}`);
          from = at + label.length;
        }
      };

      // The order is the shared outline's (core's `diagramOutline`): parent before child, source
      // before target, dates ascending.
      const tree = await draw({
        layout: "tree",
        nodes: ["root", "left", "right", "leaf"].map((id) => node(id)),
        edges: [
          { from: "root", to: "left" },
          { from: "root", to: "right" },
          { from: "left", to: "leaf" },
        ],
      });
      inOrder(tree, ["zq-root", "zq-left", "zq-leaf", "zq-right"], "tree");

      const flow = await draw({
        layout: "flow",
        nodes: ["a", "b", "c"].map((id) => node(id)),
        edges: [
          { from: "b", to: "c", label: "edge-word" },
          { from: "a", to: "b" },
          { from: "c", to: "a" }, // a cycle: allowed in a flow
        ],
      });
      inOrder(flow, ["zq-a", "zq-b", "zq-c"], "flow");
      must(has(flow, "edge-word"), `flow: an edge's label is not shown: ${show(flow)}`);

      const network = await draw({
        layout: "network",
        nodes: ["x", "y", "z"].map((id) => node(id)),
        edges: [{ from: "x", to: "y" }],
      });
      inOrder(network, ["zq-x", "zq-y", "zq-z"], "network");

      // Chronological, whatever order the nodes were listed in.
      const timeline = await draw({
        layout: "timeline",
        nodes: [
          node("late", { at: "2026-03-05" }),
          node("early", { at: "2026-01-02" }),
          node("mid", { at: "2026-02-03" }),
        ],
        edges: [],
      });
      inOrder(timeline, ["zq-early", "zq-mid", "zq-late"], "timeline");

      // A value that breaks a rule is the error state (the title, no node), never a diagram.
      const two = (extra: Record<string, unknown>) => ({
        layout: "tree",
        nodes: [node("a"), node("b")],
        edges: [{ from: "a", to: "b" }],
        ...extra,
      });
      const refused: [string, unknown][] = [
        ["duplicate node id", two({ nodes: [node("a"), node("a")] })],
        ["dangling edge", two({ edges: [{ from: "a", to: "ghost" }] })],
        ["tree with two roots", two({ edges: [] })],
        [
          "tree with a cycle",
          two({
            nodes: [node("a"), node("b"), node("c")],
            edges: [
              { from: "b", to: "c" },
              { from: "c", to: "b" },
              { from: "a", to: "a" },
            ],
          }),
        ],
        [
          "tree with a detached cycle",
          two({
            nodes: [node("a"), node("b"), node("c")],
            edges: [
              { from: "b", to: "c" },
              { from: "c", to: "b" },
            ],
          }),
        ],
        ["timeline node without `at`", { layout: "timeline", nodes: [node("a")], edges: [] }],
        [
          "timeline node with a non-date `at`",
          { layout: "timeline", nodes: [node("a", { at: "never" })], edges: [] },
        ],
        [
          "201 nodes",
          {
            layout: "network",
            nodes: Array.from({ length: 201 }, (_, i) => node(`n${i}`)),
            edges: [],
          },
        ],
        [
          "401 edges",
          {
            layout: "network",
            nodes: [node("a"), node("b")],
            edges: Array.from({ length: 401 }, () => ({ from: "a", to: "b" })),
          },
        ],
      ];
      for (const [what, value] of refused) {
        const out = await draw(value);
        must(has(out, "Probe diagram"), `${what}: the widget is gone, not refused: ${show(out)}`);
        must(!has(out, "zq-"), `${what}: drawn as a diagram instead of refused: ${show(out)}`);
      }

      // A label is data: markup stays the characters.
      const literal = await draw({
        layout: "network",
        nodes: [{ id: "a", label: "<img src=x onerror=alert(1)>" }],
        edges: [],
      });
      must(
        has(literal, "<img src=x onerror=alert(1)>"),
        `a markup-looking label was not shown literally: ${show(literal)}`
      );
    })
);

// ── references ─────────────────────────────────────────────────────────────────────────────────
check(
  "references",
  "a value's source refs are drawn with their labels; a marker emits REF_OPEN; a bad list is the error state",
  (adapter) =>
    withSession(adapter, async (s) => {
      // The six kinds a value may cite sources on, as far as this surface draws them.
      const fixtures = KIND_FIXTURES.filter(
        (f) =>
          WIDGET_REF_KINDS.includes(f.kind) &&
          adapter.kinds.includes(f.kind) &&
          f.value !== undefined
      );
      if (fixtures.length === 0) return;
      const withRefs = (f: KindFixture, refs: unknown) => ({
        ...(f.value as Record<string, unknown>),
        refs,
      });
      const draw = async (f: KindFixture, refs: unknown): Promise<string> =>
        (
          await s.mount(viewOf([widgetOf(f)]), {
            [handleOf(`w-${f.kind}`)]: { value: withRefs(f, refs), state: "ready" },
          })
        ).text();

      // Universal: a value with refs is accepted and drawn, its labels readable (a footnote counts).
      for (const f of fixtures) {
        const out = await draw(f, [{ id: "s1", label: "zq-first" }, { id: "s2.x" }]);
        for (const n of f.needles)
          must(
            has(out, n),
            `${f.kind} with refs: "${n}" is no longer on the surface: ${show(out)}`
          );
        must(has(out, "zq-first"), `${f.kind}: a ref's label is not on the surface: ${show(out)}`);
        // A label is data: markup stays the characters.
        const literal = await draw(f, [{ id: "s1", label: "<img src=x onerror=alert(1)>" }]);
        must(
          has(literal, "<img src=x onerror=alert(1)>"),
          `${f.kind}: a markup-looking ref label was not shown literally: ${show(literal)}`
        );
        // A value that breaks a rule is the error state: the title, no source label, never the widget.
        const refused: [string, unknown][] = [
          ["17 refs", Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, label: `zq-${i}` }))],
          ["a bad id", [{ id: "bad id", label: "zq-bad" }]],
          [
            "a duplicate id",
            [
              { id: "a", label: "zq-a" },
              { id: "a", label: "zq-b" },
            ],
          ],
          ["an over-long label", [{ id: "a", label: `zq-${"l".repeat(200)}` }]],
        ];
        for (const [what, refs] of refused) {
          const bad = await draw(f, refs);
          must(
            has(bad, f.title),
            `${f.kind}, ${what}: the widget is gone, not refused: ${show(bad)}`
          );
          must(
            !has(bad, "zq-"),
            `${f.kind}, ${what}: drawn with its refs instead of refused: ${show(bad)}`
          );
          for (const n of f.needles)
            must(
              !has(bad, n),
              `${f.kind}, ${what}: the value is drawn though it is refused: ${show(bad)}`
            );
        }
      }

      // Interactive surfaces: a marker is a control that emits REF_OPEN; with no host listening it is not one.
      if (adapter.capabilities?.references !== true) return;
      if (adapter.capabilities.invoke !== true) return;
      for (const f of fixtures) {
        const refs = [
          { id: "s1", label: "zq-first" },
          { id: "s2.x" },
          { id: "s3", label: "zq-third" },
        ];
        const id = `w-${f.kind}`;
        const entry = { [handleOf(id)]: { value: withRefs(f, refs), state: "ready" as const } };
        const m = await s.mount(viewOf([widgetOf(f)]), entry);
        for (const n of [2, 1, 3]) {
          const before = s.actions.length;
          await m.invoke?.(id, { kind: "ref", n });
          must(
            s.actions.length === before + 1,
            `${f.kind}: activating source ${n} emitted ${s.actions.length - before} actions, not 1`
          );
          const a = s.actions[before] as WidgetAction;
          const p = a.payload as { refId?: unknown; n?: unknown } | undefined;
          must(
            a.type === REF_OPEN_ACTION &&
              a.widgetId === id &&
              p?.refId === (refs[n - 1] as { id: string }).id &&
              p?.n === n,
            `${f.kind}: source ${n}: unexpected action ${JSON.stringify(a)}`
          );
        }
        // Nobody listening: the markers are text, so there is nothing to activate.
        const quiet = await s.mount(viewOf([widgetOf(f)]), entry, undefined, { unattended: true });
        const before = s.actions.length;
        let failed = false;
        try {
          await quiet.invoke?.(id, { kind: "ref", n: 1 });
        } catch {
          failed = true;
        }
        must(
          failed && s.actions.length === before,
          `${f.kind}: with no host listening a source marker was still a control`
        );
        must(
          has(await quiet.text(), "zq-first"),
          `${f.kind}: with no host listening the source label is gone`
        );
      }
    })
);

// ── table token cells ──────────────────────────────────────────────────────────────────────────
check(
  "table-tokens",
  "a Table token cell's labels are text; an interactive surface emits TABLE_TOKEN for an activated token",
  (adapter) =>
    withSession(adapter, async (s) => {
      if (!adapter.kinds.includes("Table")) return;
      const tokens = [
        { id: "t1", label: "zq-alpha" },
        { id: "t2", label: "zq-beta" },
      ];
      const draw = async (value: unknown) => {
        const m = await s.mount(viewOf([bound("Table", "tt", "Token table", "h-tt")]), {
          "h-tt": { value, state: "ready" },
        });
        return m;
      };
      const keyed = { columns: ["name", "tags"], rows: [["a", { tokens }]], rowKeys: ["k1"] };
      const out = await (await draw(keyed)).text();
      for (const n of ["zq-alpha", "zq-beta"])
        must(has(out, n), `a token cell's label "${n}" is not on the surface: ${show(out)}`);
      // A label is plain text: markup stays the characters.
      const literal = await (
        await draw({
          columns: ["tags"],
          rows: [[{ tokens: [{ id: "m", label: "<b>zq-bold</b>" }] }]],
        })
      ).text();
      must(
        has(literal, "<b>zq-bold</b>"),
        `a markup-looking token label was not shown literally: ${show(literal)}`
      );
      // A value that breaks a token rule is the error state: the title, no label, never the widget.
      const bad = await (
        await draw({
          columns: ["tags"],
          rows: [[{ tokens: [...tokens, { id: "t1", label: "zq-dup" }] }]],
        })
      ).text();
      must(has(bad, "Token table"), `a refused token cell dropped the widget: ${show(bad)}`);
      must(!has(bad, "zq-"), `a refused token cell was drawn anyway: ${show(bad)}`);

      if (adapter.capabilities?.tokens !== true) return;
      if (adapter.capabilities.invoke !== true) return;
      const activate = async (value: unknown): Promise<WidgetAction> => {
        const m = await draw(value);
        const before = s.actions.length;
        await m.invoke?.("tt", { kind: "token", tokenId: "t2" });
        must(
          s.actions.length === before + 1,
          `activating a token emitted ${s.actions.length - before} actions, not 1`
        );
        return s.actions[before] as WidgetAction;
      };
      const a = await activate(keyed);
      must(
        a.type === TABLE_TOKEN &&
          a.widgetId === "tt" &&
          JSON.stringify(a.payload) === JSON.stringify({ rowKey: "k1", tokenId: "t2" }),
        `a keyed table's token: unexpected action ${JSON.stringify(a)}`
      );
      const unkeyed = {
        columns: ["name", "tags"],
        rows: [
          ["a", { tokens: [{ id: "t9", label: "zq-other" }] }],
          ["b", { tokens }],
        ],
      };
      const b = await activate(unkeyed);
      must(
        b.type === TABLE_TOKEN &&
          JSON.stringify(b.payload) === JSON.stringify({ rowIndex: 1, tokenId: "t2" }),
        `an unkeyed table's token: unexpected action ${JSON.stringify(b)}`
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
    if (adapter.kinds.includes("MultiSelectInput")) {
      const w = bound("MultiSelectInput", "msel", "Pick", "h-msel", { label: "Pick some" });
      const m = await s.mount(viewOf([w]), {
        "h-msel": {
          value: {
            options: [
              { value: "alpha", label: "Alpha" },
              { value: "beta", label: "Beta" },
            ],
            selected: [],
          },
          state: "ready",
        },
      });
      // From an empty selection, in this order. Every shipped renderer can honour the order (the web
      // control adds in the order driven, the terminal ticks in the order driven), so it is exact.
      const a = await drive(m, "msel", { kind: "select-many", values: ["beta", "alpha"] });
      const p = a.payload as { values?: unknown; key?: unknown } | undefined;
      must(
        a.type === SELECT_MANY_ACTION &&
          a.widgetId === "msel" &&
          Array.isArray(p?.values) &&
          JSON.stringify(p?.values) === JSON.stringify(["beta", "alpha"]) &&
          keyOk(p?.key),
        `select-many: unexpected action ${JSON.stringify(a)}`
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

// ── a bound current value ───────────────────────────────────────────────────────────────────────
check(
  "select-current-value",
  "a SelectInput bound to its current value shows that option as chosen; an undeclared value chooses nothing and is never echoed",
  (adapter) =>
    withSession(adapter, async (s) => {
      if (!adapter.kinds.includes("SelectInput"))
        throw new ConformanceSkip("adapter does not draw SelectInput");
      const UNDECLARED = "zz-undeclared-value-9";
      const w = bound("SelectInput", "sel", "Pick", "h-sel", {
        label: "Pick one",
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      });
      const at = async (value: unknown): Promise<string> =>
        (await s.mount(viewOf([w]), { "h-sel": { value, state: "ready" } })).text();
      const alpha = await at("alpha");
      const beta = await at("beta");
      // The binding must change what a viewer READS (the selected option), not merely be tolerated:
      // a renderer that ignores it reads the same for every value.
      must(
        flat(alpha) !== flat(beta),
        `the current value is ignored: "alpha" and "beta" read the same: ${show(beta)}`
      );
      must(has(beta, "Beta") && has(beta, "Alpha"), `the options are not all drawn: ${show(beta)}`);
      const bad = await at(UNDECLARED);
      must(has(bad, "Alpha"), `an undeclared value: the control is not drawn: ${show(bad)}`);
      must(!has(bad, UNDECLARED), `an undeclared value was echoed: ${show(bad)}`);
      must(
        flat(bad) !== flat(alpha) && flat(bad) !== flat(beta),
        `an undeclared value reads as a chosen option: ${show(bad)}`
      );
    })
);

check(
  "multi-select-current-value",
  "a MultiSelectInput bound to its chosen set reads differently for each set, and shows what is chosen",
  (adapter) =>
    withSession(adapter, async (s) => {
      if (!adapter.kinds.includes("MultiSelectInput"))
        throw new ConformanceSkip("adapter does not draw MultiSelectInput");
      const w = bound("MultiSelectInput", "msel", "Pick", "h-msel", { label: "Pick some" });
      const options = [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ];
      const at = async (selected: string[]): Promise<string> =>
        (
          await s.mount(viewOf([w]), {
            "h-msel": { value: { options, selected }, state: "ready" },
          })
        ).text();
      const none = await at([]);
      const beta = await at(["beta"]);
      const alpha = await at(["alpha"]);
      // Compared on what each renderer READS, and on WHICH option the change lands on. The reading for a
      // chosen set is diffed against the empty one (common prefix and suffix cut away); the changed span is
      // what the chosen set ADDED (a chip, a "(current)" mark, a "1) Beta (current)" row). The chosen label
      // must sit strictly nearer that span than the unchosen one. This certifies the shared clause on every
      // layout: web chips and the terminal prompt (chosen rows only, the rest counted) put the label inside
      // the span; the speech sentence lists every option and puts the mark right beside the chosen one.
      // It refuses a renderer that marks the wrong option (nearest is the other), marks every option or
      // shows only a count (a tie), or ignores the set (no span).
      const nearest = (base: string, text: string, labels: readonly string[]): string[] => {
        const x = flat(base);
        const y = flat(text);
        let p = 0;
        while (p < x.length && p < y.length && x[p] === y[p]) p++;
        let q = 0;
        while (q < x.length - p && q < y.length - p && x.at(-1 - q) === y.at(-1 - q)) q++;
        const span: [number, number] = [p, y.length - q];
        if (span[0] >= span[1]) return [];
        const gap = (label: string): number => {
          let best = Number.POSITIVE_INFINITY;
          for (let i = y.indexOf(label); i >= 0; i = y.indexOf(label, i + 1))
            best = Math.min(best, Math.max(0, span[0] - (i + label.length), i - span[1]));
          return best;
        };
        const d = labels.map(gap);
        const min = Math.min(...d);
        return min === Number.POSITIVE_INFINITY ? [] : labels.filter((_, i) => d[i] === min);
      };
      for (const [chosen, text, label, other] of [
        ["beta", beta, "Beta", "Alpha"],
        ["alpha", alpha, "Alpha", "Beta"],
      ] as const) {
        const hit = nearest(none, text, [label, other]);
        must(
          hit.length === 1 && hit[0] === label,
          `choosing ["${chosen}"] does not show ${label} as the chosen option (what it changed lands on: ${JSON.stringify(hit)}): ${show(text)}`
        );
      }
    })
);

export const CHECKS: readonly Check[] = checks;
