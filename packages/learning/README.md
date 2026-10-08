# @loom-ui/learning

**The learning loop, host side (U11).** A planner chooses; a viewer reacts; the reaction becomes a
bounded reward on the decision that produced what they saw; and the log says which choice was better.
loom-ui adds no learner and no estimator: the choice is a loom decision (`decideWithPolicy`, ADRs
0078-0080), the reward is a late `runtime.recordOutcome` (ADR 0116), and the comparison is
`@loom/learning`'s `evaluatePolicy` (SNIPS) and `promotionGate`. This package is the glue that has to
distrust the browser. It is **server-side and optional**; `hydration`'s client guards name it among
the packages a client graph must not reach.

```
renderer (opt-in)            host                                   loom
SignalCollector ──batch──▶ SignalIngestor ─▶ RewardAccumulator ─▶ settleRewards ─▶ runtime.recordOutcome
 (core/signals)             validate, rate, replay,                (closed windows,     (late, owner-authorized,
                            tenant, saw-it, once                    idempotent key)      idempotent)
                                   ▲
 ReferencePlanner variants ────────┘ DecisionLinks: version ─▶ (execution, decision)        ─▶ evaluateVariants
 (decideWithPolicy, propensity)                                                                 (evaluatePolicy)
```

## The signal model

`@loom-ui/core/signals` (see core's README): `exposure`, `engagement` (click/expand counts,
dwell buckets), `feedback` (1-5), `outcome` (token + boolean), batched per surface version
(`experienceId`, `versionHash`, optional compile fingerprint), `v: 1`, at most 64 per batch. No text, no
PII, no raw timing. A restricted node is reported `restricted: true` under its opaque alias (U10c) and
is attributed at **version level only**: the host never maps an alias back to a real id.

## Decision linkage

`ReferencePlanner` with `variants` records the variant choice as a learnable decision
(`PlanResult.report.variant.decisionId`; propensity in the log). `plannerProvenance(result)` stamps it
on the ops as `Provenance.policyDecisionId`, so the U12 ledger already says which decision wrote which
node. The host registers what it knows per surface version:

```ts
const links = new DecisionLinks();
links.register(experienceId, versionHash, linkFromLedger(ledger, {
  executionOf: (decisionId) => executionByDecision.get(decisionId),   // the host ran the turn
  tenant,
}));
```

A signal on a node credits that node's decision; a version-level signal (an outcome, a surface
rating, a restricted node) credits every decision of the version; a node the link does not list (a
human edit) earns the planner nothing.

## Ingesting untrusted signals

`new SignalIngestor({ links, accumulator, clock, exposure? }).ingest({ viewer, raw })`, where `viewer`
comes from the host's **authenticated session** (never the payload; a `viewerId` in the batch is
ignored). In order:

| Check | Refusal |
|---|---|
| shape: `validateSignalBatch` (bounded tokens, in-range ints, <=64 signals, extra keys stripped) | `batch-invalid`; a bad *signal* in a good batch is dropped and counted (`invalid`) |
| replay: a `batchId` already accepted for this viewer | `duplicate-batch` |
| view: registered, in the viewer's tenant | `unknown-view` (a foreign tenant's view is indistinguishable from an unregistered one) |
| rate: `rateLimit` signals per viewer per `rateWindowMs`; over budget refuses the batch whole and does **not** remember it | `rate-limited` |
| saw it: engagement, feedback and outcome count only after the viewer's exposure | `unexposed` |
| once: exposure, each engagement action, feedback and outcome count once per (viewer, version, node) | `duplicate` |
| node: must be one the link lists | `unknown-node` |
| restricted exposures counted per viewer and version | `restricted-cap` |
| accumulator is full | `capacity` |

**Saw it.** The ingestor's own ledger of accepted exposures is client-*claimed*: it stops an
engagement on a node the client never claimed to show, not a determined forger of both. For a reward
you will pay for, pass an authoritative `exposure` check: `seenLogExposure(seenLog)` re-checks the
U12 `SeenLog` (the server-recorded view of this exact version for this viewer; an erased viewer or an
unreadable log answers no), alone or with `allOf(...)`.

Memory is bounded everywhere (remembered keys, batch ids, viewers, accumulator buckets). A bound
evicts the oldest remembered key, so a very old duplicate could count again; the per-batch, per-viewer
rate and the once-per-key rule bound what that can add.

## Rewards

`defaultReward({ engagement, feedback, outcome })` is a weighted mean of the components a window has
(engaged share of exposed node views; mean rating mapped to 0-1; outcome success rate), in `[0, 1]`,
`undefined` with no exposure. Any `RewardFunction` fits. `settleRewards({ accumulator, runtime, reward,
rewardId, before, authorize })` settles **closed** windows only (`before = ingestor.windowOf(clock())`):
one `recordOutcome` per (execution, decision, window) with key `ui:<rewardId>:<window>`, score clamped
to `[0, 1]`, authorized per decision by `authorize(ref)` (`{ principal }` of the execution's owner, the
ADR 0116 default `annotate: owner`). Re-running is safe (the kernel's `(decisionId, key)` idempotency);
a *different* score for the same pair is refused by the kernel, never overwritten, which is why a window
is only settled once it can no longer change. A still-running execution is `deferred` and retried;
a refusal (unauthorized, unknown decision, conflict) is dropped and reported in `refused`, never retried
forever. Several windows' scores for a decision are averaged by `trajectories`. The accumulator is in
memory: persist it (or settle often) if a restart must not lose an open window.

## UI evaluation

`evaluateVariants(events, { thresholds })` takes exported events (any `EventStore.read`), keeps the
variant decisions, scores the late rewards against them (terminal completion is **not** credited to a
variant), and evaluates "always variant V" for each V with `evaluatePolicy`, gated by `promotionGate`.
It returns per-variant `EvalReport`s, best estimate first, and a `winner` only if one passes the gate.
loom's defaults demand 1000 evaluable steps, so a small trial passes its own `thresholds`
(`minSteps`, `minEffectiveSamples`, `minUnits`).

## Reference example spec: `planner-learning` (for `loom-examples`)

Not in this repo (examples live in the sibling `loom-examples`). Proposed shape, headless and offline:

1. Two planner variants, `flat` ("prefer one flat list") and `tabs` (`REFERENCE_CONTAINER_ROLES` plus "prefer grouped tabs"), assigned by `stableBucketPolicy` over 200 synthetic users, with a scripted model.
2. Each user's turn runs in its own owner-attributed execution; `plannerProvenance` + `linkFromLedger` register the version's decisions.
3. Simulated viewers drive a `SignalCollector` (exposure, clicks, dwell, a rating); batches go through a `SignalIngestor` with `seenLogExposure`.
4. `settleRewards` at window close records the late rewards as the owner.
5. `evaluateVariants` over the exported logs prints the per-variant SNIPS table and names the winner (`tabs`); the same table with `minSteps: 10_000` names none, and the example prints why.
6. Optional last step: swap in `epsilonGreedyPolicy` with the winner as `greedy` and show the new propensities in the log.
