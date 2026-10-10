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

const FAULTS: Array<[string, string, RendererAdapter]> = [
  [
    "unknown-kind",
    "silently drops an unregistered kind",
    textOf((t) => t.replace(/NoSuchKindAnywhere|Mystery title/g, "")),
  ],
  ["kinds", "leaks [object Object]", textOf((t) => `${t} [object Object]`)],
  ["restricted", "dumps every stored value", textOf((t, v) => `${t} ${JSON.stringify(v)}`)],
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
  ["untrusted-text", "interprets markup", textOf((t) => t.replace(/<\/?b>/g, ""))],
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
