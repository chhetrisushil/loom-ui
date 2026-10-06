import type { Experience, Finding } from "./experience";
import { type OpResult, type Operation, replay } from "./operations";

/**
 * Folds PARTIAL op lists, as a streaming planner emits them, into a WORKING copy of an
 * experience a UI can show while the plan is still being written.
 *
 * Each `update` carries the whole pending op list so far (a later partial SUPERSEDES the earlier
 * one — a node a stream revises is just a different list), applied with `replay` against the
 * unchanged base. So there is no state to unwind and a partial that does not apply is a finding,
 * with the last good working copy kept.
 *
 * The working copy is NEVER committed: it is unsealed (`versionHash` ""), nothing here touches a
 * lineage, and the value that does reach one is `finish(finalOps)` — exactly `replay(base,
 * finalOps)`, the same as if no partial had ever been shown. Partials are a live affordance only.
 */
export class OpStream {
  private current: Experience;
  private count = 0;
  private readonly maxPartials: number;

  constructor(
    private readonly base: Experience,
    opts: { readonly maxPartials?: number } = {}
  ) {
    this.current = base;
    this.maxPartials = opts.maxPartials ?? 256;
  }

  /** The last partial that applied (the base before any). Unsealed unless the base was sealed and nothing applied. */
  get working(): Experience {
    return this.current;
  }
  /** How many partials were applied (refused ones are not counted). */
  get partials(): number {
    return this.count;
  }

  update(ops: readonly Operation[]): OpResult<Experience> {
    if (this.count >= this.maxPartials)
      return {
        ok: false,
        finding: finding(
          "stream-partials-exceeded",
          `more than ${this.maxPartials} partial updates; the stream is over-chatty, wait for the final plan`
        ),
      };
    const r = replay(this.base, ops);
    if (r.ok) {
      this.current = r.value;
      this.count += 1;
    }
    return r;
  }

  /** The authoritative result: the final ops folded onto the base, ignoring every partial. */
  finish(finalOps: readonly Operation[]): OpResult<Experience> {
    const r = replay(this.base, finalOps);
    if (r.ok) this.current = r.value;
    return r;
  }
}

const finding = (code: string, message: string): Finding => ({ code, severity: "error", message });
