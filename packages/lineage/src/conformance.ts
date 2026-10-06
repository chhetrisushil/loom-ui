import type { Finding } from "@loom-ui/core";
import type { LineageStore } from "./store";

// ── The LineageStore conformance kit ──────────────────────────────────────────
// Returns findings (a test asserts the list is empty), never throws: a store that throws on a case
// is reported as a finding, like `checkPlannerConformance`. Each case uses a fresh line id, so one
// `make()` store serves them all — but a backend that cannot isolate lines is exactly what the
// "lines are independent" case catches.

const rec = (n: number) => ({
  type: "EXPERIENCE_COMPOSED",
  payload: { n },
  at: "2026-10-06T00:00:00.000Z",
});

export async function checkLineageStoreConformance(
  make: () => LineageStore | Promise<LineageStore>
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fail = (code: string, message: string) =>
    findings.push({ code, severity: "error", message });
  const store = await make();
  const cases: Array<[string, () => Promise<void>]> = [
    [
      "an unknown line reads empty",
      async () => {
        const r = await store.read("c-empty");
        if (r.length !== 0) fail("read-unknown", `an unknown line read ${r.length} records`);
      },
    ],
    [
      "append at tip 0 wins sequence 1; the sequence is dense",
      async () => {
        const a = await store.append("c-seq", 0, rec(1));
        const b = await store.append("c-seq", 1, rec(2));
        if (!a.ok || a.sequence !== 1 || !b.ok || b.sequence !== 2)
          fail("append-sequence", `sequential appends returned ${JSON.stringify([a, b])}`);
        const r = await store.read("c-seq");
        if (r.map((x) => x.sequence).join() !== "1,2")
          fail("read-order", `read returned sequences ${r.map((x) => x.sequence).join()}`);
      },
    ],
    [
      "a stale expectedSequence is refused with the real tip and writes nothing",
      async () => {
        await store.append("c-stale", 0, rec(1));
        const s = await store.append("c-stale", 0, rec(2));
        if (s.ok || s.tip !== 1)
          fail("stale-append", `a stale append returned ${JSON.stringify(s)}`);
        const ahead = await store.append("c-stale", 5, rec(3));
        if (ahead.ok || ahead.tip !== 1)
          fail("gap-append", `an append past the tip (a gap) returned ${JSON.stringify(ahead)}`);
        const r = await store.read("c-stale");
        if (r.length !== 1) fail("refused-wrote", `a refused append left ${r.length} records`);
      },
    ],
    [
      "of N concurrent appends at one tip exactly one wins",
      async () => {
        const outs = await Promise.all(
          Array.from({ length: 8 }, (_, i) => store.append("c-race", 0, rec(i)))
        );
        const wins = outs.filter((o) => o.ok).length;
        if (wins !== 1) fail("race", `${wins} of 8 concurrent appends at the same tip won`);
        const r = await store.read("c-race");
        if (r.length !== 1) fail("race-log", `the raced line holds ${r.length} records`);
      },
    ],
    [
      "lines are independent",
      async () => {
        await store.append("c-iso-a", 0, rec(1));
        const b = await store.append("c-iso-b", 0, rec(2));
        if (!b.ok)
          fail("isolation", "an append to a second line was refused by the first line's tip");
        if ((await store.read("c-iso-a")).length !== 1)
          fail("isolation", "a line holds another's record");
      },
    ],
    [
      "payloads round-trip and neither side aliases the log",
      async () => {
        const payload = { nested: { list: [1, 2, { k: "v" }] } };
        await store.append("c-copy", 0, {
          type: "EXPERIENCE_COMPOSED",
          payload,
          at: "2026-10-06T00:00:00.000Z",
        });
        payload.nested.list.push(3);
        const first = await store.read("c-copy");
        if (
          JSON.stringify(first[0]?.payload) !==
          JSON.stringify({ nested: { list: [1, 2, { k: "v" }] } })
        )
          fail("copy-in", "mutating a payload after append changed the stored record");
        (
          first as unknown as Array<{ payload: { nested: { list: unknown[] } } }>
        )[0]?.payload.nested.list.push(9);
        const second = await store.read("c-copy");
        if (JSON.stringify(second[0]?.payload).includes("9"))
          fail("copy-out", "mutating a read result changed the stored record");
        if (
          second[0]?.type !== "EXPERIENCE_COMPOSED" ||
          second[0]?.at !== "2026-10-06T00:00:00.000Z"
        )
          fail("fields", "type or at did not round-trip");
      },
    ],
  ];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (err) {
      fail("store-threw", `${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return findings;
}
