import { stripUnsafeChars } from "@loom-ui/core/chat-ui";
import { describe, expect, it } from "vitest";
import type { MountedRenderer, RendererAdapter } from "./adapter";
import { checkRendererConformance } from "./run";
import { speechAdapter } from "./speech.test-support";
import { describeRendererConformance } from "./vitest";

// The reference third-party renderer passes the whole kit, with nothing skipped.
describeRendererConformance(speechAdapter, { forbidSkips: true });

// The kit's own evidence that it is not vacuous: each fault below breaks ONE contract clause in an
// otherwise-conforming renderer, and the kit must name that clause (and only fail that run).
type MountOptions = Parameters<RendererAdapter["mount"]>[1];
interface Fault {
  /** Rewrite the mounted view (its text, its set, its dispose...). */
  readonly view?: (m: MountedRenderer, values: MountOptions["values"]) => MountedRenderer;
  /** Rewrite what the host hands the renderer. */
  readonly options?: (o: MountOptions) => MountOptions;
}
const faulty = (f: Fault): RendererAdapter => ({
  ...speechAdapter,
  async mount(bp, o) {
    const given = f.options?.(o) ?? o;
    const m = await speechAdapter.mount(bp, given);
    return f.view?.(m, o.values) ?? m;
  },
});
const textOf = (fn: (t: string, v: MountOptions["values"]) => string) =>
  faulty({ view: (m, v) => ({ ...m, text: async () => fn(await m.text(), v) }) });

// A renderer that forgets to sanitise ONE source: after the honest render, the cleaned text of that
// source is swapped for the raw string it came from.
const walkTitles = (n: unknown, out: string[] = []): string[] => {
  if (typeof n !== "object" || n === null) return out;
  const o = n as { title?: unknown; children?: unknown[]; node?: unknown };
  if (typeof o.title === "string") out.push(o.title);
  walkTitles(o.node, out);
  for (const c of o.children ?? []) walkTitles(c, out);
  return out;
};
const cleaned = (raw: string): string => stripUnsafeChars(raw).replace(/\s+/g, " ").trim();
const unsanitised = (
  raws: (bp: Parameters<RendererAdapter["mount"]>[0], o: MountOptions) => string[]
): RendererAdapter => ({
  ...speechAdapter,
  async mount(bp, o) {
    const m = await speechAdapter.mount(bp, o);
    return {
      ...m,
      text: async () => {
        let t = await m.text();
        for (const r of raws(bp, o)) t = t.replace(cleaned(r), r);
        return t;
      },
    };
  },
});

/** The blueprint with every `source.redacted` mark dropped: a renderer that does not know IR 2.5.0. */
const withoutRedaction = (bp: Parameters<RendererAdapter["mount"]>[0]) => {
  const copy = structuredClone(bp);
  const strip = (n: unknown): void => {
    if (typeof n !== "object" || n === null) return;
    const o = n as { source?: { redacted?: unknown }; node?: unknown; children?: unknown[] };
    if (o.source) o.source.redacted = undefined;
    strip(o.node);
    for (const c of o.children ?? []) strip(c);
  };
  strip(copy.layout);
  return copy;
};

const FAULTS: Array<[string, string, RendererAdapter]> = [
  [
    "unknown-kind",
    "silently drops an unregistered kind",
    textOf((t) => t.replace(/NoSuchKindAnywhere|Mystery title/g, "")),
  ],
  ["kinds", "leaks [object Object]", textOf((t) => `${t} [object Object]`)],
  ["restricted", "dumps every stored value", textOf((t, v) => `${t} ${JSON.stringify(v)}`)],
  ["audience", "dumps every stored value", textOf((t, v) => `${t} ${JSON.stringify(v)}`)],
  [
    "audience",
    "draws a redacted widget as an ordinary one",
    {
      ...speechAdapter,
      mount: (bp, o) => speechAdapter.mount(withoutRedaction(bp), o),
    },
  ],
  [
    "status-matrix",
    "never shows a finding",
    faulty({ view: (m) => ({ ...m, set: (h, e) => m.set(h, { ...e, message: "" }) }) }),
  ],
  ["live-update", "ignores later data", faulty({ view: (m) => ({ ...m, set: () => undefined }) })],
  [
    "live-update",
    "keeps following data after dispose",
    faulty({ view: (m) => ({ ...m, dispose: () => undefined }) }),
  ],
  [
    "incremental-update",
    "ignores update()",
    faulty({ view: (m) => ({ ...m, update: () => undefined }) }),
  ],
  [
    "container-roles",
    "reads panels out of order",
    textOf((t) => t.split(". ").reverse().join(". ")),
  ],
  ["untrusted-text", "passes an escape sequence through", textOf((t) => `${t}\u001b[2J`)],
  [
    "untrusted-text",
    "draws a widget title unsanitised",
    unsanitised((bp) => walkTitles(bp.layout)),
  ],
  [
    "untrusted-text",
    "draws a translated word unsanitised",
    unsanitised((_bp, o) => Object.values(o.i18n?.messages ?? {}) as string[]),
  ],
  ["untrusted-text", "interprets markup", textOf((t) => t.replace(/<\/?b>/g, ""))],
  [
    "chat-markdown",
    "draws an address outside the allowlist",
    textOf((t) => `${t} javascript:alert-sentinel`),
  ],
  [
    "chat-markdown",
    "draws an image address",
    textOf((t) => `${t} https://tracker.example/pixel.png`),
  ],
  [
    "chat-markdown",
    "interprets html in markdown",
    textOf((t) => t.replace("<b>raw-html-leak</b>", "raw-html-leak")),
  ],
  [
    "chat-markdown",
    "parses a part that did not ask for markdown",
    textOf((t) => t.replace("**stay-literal**", "stay-literal")),
  ],
  ["chat-markdown", "draws a person's turn as markdown", textOf((t) => `${t} user-md-refused`)],
  [
    "chat-markdown",
    "claims markdown and shows its source",
    textOf((t) => `${t} [good-label] and a fence ${"`".repeat(3)}`),
  ],
  [
    "media-refs",
    "prints a media address",
    textOf((t) => `${t} sha256:0123456789abcdef0123456789abcdef`),
  ],
  [
    "i18n",
    "ignores the host's words",
    faulty({ options: (o) => ({ ...o, i18n: undefined as never }) }),
  ],
  [
    "actions",
    "emits a different action shape",
    faulty({
      options: (o) => ({ ...o, onAction: (a) => o.onAction({ ...a, type: a.type.toLowerCase() }) }),
    }),
  ],
];

describe("the kit fails a renderer that breaks a clause", () => {
  for (const [id, fault, adapter] of FAULTS)
    it(`${id}: ${fault}`, async () => {
      const report = await checkRendererConformance(adapter);
      expect(report.failed.map((r) => r.id)).toContain(id);
    });
  it("an honest renderer passes every check, none skipped", async () => {
    const report = await checkRendererConformance(speechAdapter);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.ok).toBe(true);
  });
  it("a check an adapter has no capability for is reported as skipped, not passed", async () => {
    const report = await checkRendererConformance({ ...speechAdapter, capabilities: {} });
    expect(report.skipped.map((r) => r.id).sort()).toEqual([
      "actions",
      "i18n",
      "incremental-update",
    ]);
  });
});
