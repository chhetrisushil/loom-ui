import {
  type Experience,
  type Provenance,
  type RecordedOperation,
  type SemanticNode,
  genesis,
} from "@loom-ui/core";
import type { HeadSignal } from "@loom-ui/core";
import { Lineage, type LineageStore } from "@loom-ui/lineage";
import { InMemoryLineageStore } from "@loom-ui/lineage";
import { InMemoryContentStore } from "@loom/plugin-content";
import type { FeedHarness } from "./conformance";
import { LineageChangeFeed } from "./feed";
import { pollingHeadSignal } from "./signal";

export const by: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
export const g = (id: string): Experience =>
  genesis({ experienceId: id, intent: { objective: "o", source: "user" }, meta });
export const node = (
  id: string,
  handle: string,
  sensitivity?: "secret" | "internal"
): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
});
export const ins = (n: SemanticNode): RecordedOperation => ({
  op: { type: "insertNode", parentId: "root", node: n },
  by,
  at: "2026-10-06T00:00:00Z",
});
export const clock = () => {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 6, 0, 0, n++)).toISOString();
};

/** A manual timer: `fire()` runs every scheduled callback and lets the checks settle. */
export function manualTimer() {
  const fns = new Set<() => void>();
  return {
    schedule: (fn: () => void) => {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    size: () => fns.size,
    fire: async () => {
      for (const fn of [...fns]) fn();
      await new Promise((r) => setTimeout(r, 3));
    },
  };
}

export function makeLineage(events: LineageStore = new InMemoryLineageStore()) {
  const lineage = new Lineage({ events, content: new InMemoryContentStore(), now: clock() });
  let n = 0;
  /** Append one version: genesis on an empty line, else one more tile. */
  const compose = async (experienceId: string, summary?: string): Promise<void> => {
    const head = await lineage.head(experienceId);
    if (!head.ok) throw new Error("head");
    if (head.value === null) {
      const r = await lineage.start(g(experienceId), by);
      if (!r.ok) throw new Error(JSON.stringify(r.refusal));
      return;
    }
    n += 1;
    const r = await lineage.compose({
      experienceId,
      expectedHead: head.value,
      ops: [ins(node(`n${n}`, `h${n}`))],
      by,
      ...(summary !== undefined && { summary }),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  };
  return { events, lineage, compose };
}

export function manualHarness(): FeedHarness & {
  timer: ReturnType<typeof manualTimer>;
  events: LineageStore;
  lineage: Lineage;
} {
  const l = makeLineage();
  const timer = manualTimer();
  const signal: HeadSignal = pollingHeadSignal(l.events, { schedule: timer.schedule });
  return {
    feed: new LineageChangeFeed({ lineage: l.lineage, events: l.events, signal }),
    compose: l.compose,
    tick: timer.fire,
    timer,
    events: l.events,
    lineage: l.lineage,
  };
}
