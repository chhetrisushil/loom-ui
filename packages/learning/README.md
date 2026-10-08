# @loom-ui/learning

**The learning loop, host side (U11).** A planner chooses; viewers react; the reactions become ONE
bounded reward on the decision that produced what they saw; and the log says which choice was better.
loom-ui adds no learner and no estimator: the choice is a loom decision (`decideWithPolicy`, ADRs
0078-0080), the reward is a late `runtime.recordOutcome` (ADR 0116), the comparison is
`@loom/learning`'s `evaluatePolicy` (SNIPS) and `promotionGate`. This package is the glue that has to
distrust the browser. It is **server-side and optional**; `hydration`'s client guards name it among
the packages a client graph must not reach.

```
renderer (opt-in)          host                                              loom
SignalCollector ─batch─▶ SignalIngestor ─vote─▶ VoteLedger (append-only ─▶ settleRewards ─▶ runtime.recordOutcome
 (core/signals)           cost, shape, tenant,   VoteLog, CAS)  fold =      (close = CLAIM,    (late, one key per
                          node, saw-it, names                   1 vote per   frozen summary)    decision)
                                  ▲                              viewer
ReferencePlanner variants ────────┘ DecisionLinks: (tenant, version) ─▶ (execution, decision) ─▶ evaluateVariants
 (decideWithPolicy, propensity)                                                                    (evaluatePolicy)
```

## The signal model

`@loom-ui/core/signals` (see core's README): `exposure`, `engagement` (click/expand counts, dwell
buckets sent once per view), `feedback` (1-5), `outcome` (token + boolean), batched per surface version,
`v: 1`, at most 64 per batch. No text, no PII, no raw timing. A restricted node is reported
`restricted: true` under its opaque alias (U10c); the host collapses **every** restricted signal of a
viewer onto one version-level pseudo node, so an alias carries no weight and no real id is ever needed.

## Decision linkage

`ReferencePlanner` with `variants` records the variant choice as a learnable decision
(`PlanResult.report.variant.decisionId`; propensity in the log). `plannerProvenance(result)` stamps it
as `Provenance.policyDecisionId`, so the U12 ledger already says which decision wrote which node. The
host registers what it knows per (tenant, experience, version):

```ts
const links = new DecisionLinks();
links.register(experienceId, versionHash, linkFromLedger(ledger, {
  executionOf: (decisionId) => executionByDecision.get(decisionId),   // the host ran the turn
  tenant,                                                             // REQUIRED
  visibleTo: (viewer) => nodesCompiledVisibleFor(viewer),             // the host's own compile
}));
```

A node signal credits that node's decision; version-level facts (a surface rating, an outcome) and
restricted nodes credit every decision of the version; a node the link does not list, or that is not
visible to this viewer, earns nothing and **answers identically** (`unknown-node`), so the host is not an
existence oracle for hidden nodes. A link without a `tenant` cannot be registered, and the link is looked
up by tenant: the same experience id in two tenants is two links.

## Ingesting untrusted signals

```ts
const ledger = new VoteLedger({ log, pseudonymKey, clock, outcomes: ["task-approved"] });
const ing = new SignalIngestor({ links, ledger, clock, exposure: seenLogExposure(seenLog, { versionIsEnough: false }) });
const result = await ing.ingest({ viewer: { id: session.userId, tenant: session.tenant }, raw: req.body });
res.status(204).end();     // ALWAYS the same bare answer; keep `result` in server logs
```

**Answer every well-formed POST with the same bare 204 and keep `IngestResult` server-side.** Its
reasons (`unknown-node`, `unexposed`, `unknown-outcome`...) are for your logs; echoing them lets a client
probe what exists, what it may see and which names are registered.

The viewer is the host's authenticated session, **keyed by tenant and id**; a `viewerId` in the payload
is ignored. In order: **cost** (every call, accepted or refused, is charged to the viewer's rate budget
before it is parsed; an over-budget call is refused whole and not remembered) -> **shape**
(`validateSignalBatch`) -> **view** (registered for this tenant; a foreign tenant's view and an
unregistered one answer alike) -> **node** (listed + visible; a `restricted` flag on a node the link
lists is refused) -> **saw it** -> **outcome names** (only those registered with the ledger; a client
cannot mint outcomes). Replays of a `batchId` are refused fast per viewer and ignored by the fold.

**Exposure is required.** `exposure` is an authoritative `ExposureCheck` or the explicit string
`"client-claimed"` (demos and tests). Use `seenLogExposure(seenLog, { versionIsEnough: false })` wherever
nodes are data-bound: the server-recorded view of this exact version, with the node among the recorded
entries (an erased viewer or an unreadable log answers no). Static nodes leave no entry in a `SeenLog`;
for those the default `versionIsEnough: true` accepts a recorded view of the version. `"client-claimed"`
stops an engagement on a node the client never claimed to show, and nothing more.

## One bounded vote per viewer (the vote ledger)

Accepted signals are appended to an **append-only log per decision** (`VoteLog`: `append` iff the tip is
`n`, `read`; structurally `@loom-ui/lineage`'s `LineageStore`, so `eventStoreLineageStore(eventStore)`
over SQLite/Postgres is the durable reference and `InMemoryVoteLog` the single-process one). The score
is a **fold** of the log, and the fold reduces each viewer to one vote: engagement = engaged nodes /
exposed nodes (a click, an expand or dwell >= 5 s counts; counts capped), the latest rating, outcomes
by registered name, at most 64 nodes and 128 batches per viewer, at most 100 000 viewers per decision
(`overflowViewers` counts the rest, in log order). Pooling is a mean of per-viewer terms in [0,1], so no
client-controlled number multiplies a reward. A replayed batch is ignored (an old rating cannot override
a newer one); an engagement or rating counts only after the **same viewer's** exposure of that node.

Because there is no in-memory "once" ledger, there is nothing to evict: the per-decision entry cap
(`maxEntriesPerDecision`) makes ingest **refuse** (`capacity`) rather than forget. The in-memory log is a
single ingesting process; any number of replicas can share a durable `VoteLog`, and the log's CAS
interleaves their appends. Viewers appear in the log only as `viewerKey` = HMAC(`pseudonymKey`, tenant,
id); destroy the key and the votes can no longer be tied to a person.

## Rewards: settle once, at a close

`settleRewards({ ledger, runtime, decisions, reward, rewardId, closeId, authorize, clock })` closes each
decision at a host-declared moment (an experiment end, a TTL after the execution finished). The close
appends a **CLAIM** to the decision's log; every reader folds only the votes before the first CLAIM, so
two replicas settling at once compute the **same frozen summary and score**, and the kernel's
`(decisionId, key)` idempotency absorbs the repeat (a conflicting score is impossible, not merely
refused). One `recordOutcome` per decision, key `ui:<rewardId>:<closeId>:<specHash>` (`specHash` names the
ledger's outcome names and caps, so a changed spec records under a new key). `defaultReward` is the
weighted mean 1 / 2 / 3 of engagement, rating and outcome rate **over per-viewer terms**, in [0,1].

Why once and not per window: `trajectories` averages a decision's outcomes with equal weight, so many
partial windows would let a 1-viewer window weigh the same as a 10 000-viewer one. Windows are not
offered; if you need periodic results, use a new decision (a new planner turn) per period. Give a
decision ONE `rewardId`/`closeId` for life.

- **Principal.** `authorize(ref)` returns who records it. Prefer a **reward-pipeline principal** granted
  `annotate` for its tenant (`executionAccessPolicy({ rules: { annotate: "tenant" } })`) or a system
  grant over impersonating each owner; ADR 0116's default is `annotate: owner`, under which any other
  principal is refused (tested).
- **Terminal only.** `recordOutcome` refuses a running execution (ADR 0116). Run learning-relevant planner
  turns in **short executions** (plan, record, finish), not inside a long-lived agent loop. A not-yet-
  terminal decision is `deferred` and retried; past `maxDeferralMs` (default 7 days, aged from the CLAIM)
  it is `abandoned`, marked settled and reported. A transient failure (anything not typed permanent) is
  retried up to `maxAttempts` per process, then abandoned; only `ExecutionDeniedError` and
  `OutcomeRefusedError` are treated as permanent refusals (marked settled, reported in `refused`).
  Not-terminal detection is by error name, isolated in `isNotTerminal` (TODO: a loom typed check).

## UI evaluation

`evaluateVariants(events, { rewardId, thresholds })` takes exported events (any `EventStore.read`; for a
compacted execution pass `evidenceEvents(state, events)` from `@loom/learning`, not the raw tail), keeps
the variant decisions and **only the outcomes this pipeline recorded** (key `ui:<rewardId>:` AND
kernel-stamped; an unrelated CSAT outcome on the same decision is excluded: tested), and evaluates
"always variant V" for each V with `evaluatePolicy` gated by `promotionGate`. The unit of an execution is
its first variant decision's. It returns per-variant reports, best first, and a `winner` only if one
passes the gate **and** the logging policy explored: if every variant choice was logged with propensity 1
(UCB, a greedy policy) no estimate is unbiased and no winner is named unless
`allowDeterministicLogging: true`. loom's default gate demands 1000 steps; a small trial passes its own
thresholds.

## Units and erasure

The planner's `unit` is a pseudonym: derive it server-side with `unitAlias(key, userId)` (HMAC), never
from a client, never a raw id or email. It is recorded in the decision log for good; destroying the key
severs it from the person, but the log still ties one alias's decisions together. `viewerKey` in the vote
log is a separate HMAC domain under the same kind of key.

## Reference example spec: `planner-learning` (for `loom-examples`)

Not in this repo (examples live in the sibling `loom-examples`). Proposed shape, headless and offline:

1. Two planner variants, `flat` and `tabs` (`REFERENCE_CONTAINER_ROLES` plus "prefer grouped tabs"), assigned by `stableBucketPolicy` over 200 synthetic users whose `unit` is `unitAlias(key, userId)`, with a scripted model.
2. Each user's turn runs in its own short, owner-attributed execution; `plannerProvenance` + `linkFromLedger` register the version's decisions.
3. Simulated viewers drive a `SignalCollector`; batches go through a `SignalIngestor` with `seenLogExposure` into a `VoteLedger` over `eventStoreLineageStore`.
4. `settleRewards` at the close records one pooled late reward per decision as a reward-pipeline principal; a second ledger instance over the same log shows the same summaries.
5. `evaluateVariants` over the exported logs prints the per-variant SNIPS table and names the winner (`tabs`); a stricter gate names none and says why; a UCB-logged run names none and says "deterministic".
6. Optional: swap in `epsilonGreedyPolicy` with the winner as `greedy` and show the new propensities in the log.
