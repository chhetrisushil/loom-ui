# loom-ui readiness for futuristic agentic applications (audit F)

Date 2026-10-05. Subject: loom-ui main 0b58739 (packages core, hydration, planner, renderer-lit, renderer-terminal) on loom main 2309ca3. Read-only. Judged from CODE only; READMEs/ADRs/memory ignored unless the code confirms. Paths below are relative to `packages/`. Legend: ✅ exists and sound, ⚠️ partial / app must supply, ❌ absent. Maturity: P = production-grade, Pr = prototype, S = stub/type-only.

Throwaway measurements (a local bench script against built `dist`, not committed): `seal()` of a 5,000-node experience = ~235 ms (500 nodes = ~26-37 ms; 2,000 = ~96 ms); `apply(setProps)` = 0.14 ms at 500, 0.52 ms at 5,000 nodes; `compile()` = 4-8 ms at 5,000 semantic nodes. DOM reconcile was not measurable without a browser.

## 0. What loom-ui actually is (from code)

A deterministic, pure-function pipeline: `Experience` (zod tree of container/semantic nodes + provider specs + intent; core/src/experience.ts:62-71) -> ops (`apply`/`replay`, core/src/operations.ts:258,525) -> `seal` (sha256 of the canonical artifact, core/src/log.ts:56) -> `compile` to a loom `Blueprint` (core/src/compile.ts:90) -> `renderBlueprintDom`/`renderExperience` bound to a `HydrationStore` projection. A `Planner` (ReferencePlanner) turns a prompt into ops inside ONE `ctx.decide`. Hydration loads data per handle (transient, in-memory). It is a *view/compile/hydrate/plan library*; it is NOT a runtime: there is no lineage store, head pointer, event emission, notification, scheduler, or session. Persistence is `putExperience/getExperience` (content store bytes) and two event-name constants (`EXPERIENCE_COMPOSED` core/src/log.ts:19, `EXPERIENCE_PROMOTED` planner/src/interaction.ts:77) with payload types only; nothing in the packages builds or emits them (grep: only the constant/type definitions). The app wires everything (examples/experience-recompose/src/app.ts is a 438-line in-memory wiring).

---

## 1. HOT-PATH UI (agent drives UI turn by turn)

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Op-based, replayable edits (insert/remove/move/setProps/setLabel/setPlacement/bindProvider/remap...) | ✅ | P | core/src/operations.ts:42-61 (12 op types), pure+total `apply` :258, `replay` :525; findings not throws | none |
| Fast local apply -> compile -> render loop | ✅ | P | apply 0.5 ms and compile 8 ms at 5k nodes (measured); `DomRenderHandle.update` keyed reconcile, never throws, focus pin (renderer-lit/src/dom/renderBlueprintDom.ts:47-58, reconcile.ts:68-110) | seal (zod parse + canonical JSON) is 235 ms at 5k nodes and runs on every `putExperience`/`seal`; a hot loop must not seal per op. loom-ui: offer an incremental/unsealed "working copy" path or cheaper hash |
| Agent turn = one `revise` call | ⚠️ | Pr | planner/src/reference.ts:117-171; model SPI `complete()` returns whole string (planner/src/spi.ts:75-84) | The turn is request/response, NOT streaming. A model call + up to `maxAttempts` (default 2) retries before ANY UI change. loom-ui (planner SPI) |
| Streaming partial UI while the agent decides | ❌ | - | `PlannerModel.complete` is non-streaming (spi.ts:75); `parseModelJson` needs the full JSON (planner/src/contract.ts `parseModelJson`); no AsyncIterable/ReadableStream/onChunk anywhere in core/hydration/planner/renderer (grep) | Needs: streaming planner SPI emitting incremental ops (insertNode skeleton first, props fill later), partial-JSON parser, op-stream folding into `Experience`. loom-ui (planner+core), plus loom `ctx.decide` has to record a stream (loom) |
| Progressive render / skeletons | ⚠️ | Pr | Per-handle status matrix gives loading/pending/stale/error/empty per widget (renderer-lit/src/widgets/base.ts:60-190); P0/P1/P2 priorities (hydration/src/scheduler.ts:18-40) | Skeleton exists only for DATA loading ("..." text, base.ts `state loading`), not for "node not yet composed". No placeholder node op. loom-ui |
| Token streams into widgets | ⚠️ | S | `StreamingText` kind is a plain string value renderer (renderer-lit/src/widgets/lu-simple.ts:93-111; core/src/kindValues.ts:382); value comes from `HydrationStore.setValue` (hydration/src/projection.ts:148), which an app could call repeatedly, but the controller owns handle lifecycle and its `retain`/supersede logic would race | The name is aspirational: there is no token-append contract, no sequence/offset, no "done" marker. Only per-handle replace semantics. loom-ui (value contract + store `append`) |
| Optimistic updates | ⚠️ | Pr | `apply` is pure so an app can apply locally and render (`App.retype` in examples) | No pending/confirm/rollback machinery, no op ids, no base-version precondition. loom-ui (core) or app |
| Cancellation / interruption of a turn | ⚠️ | Pr | Hydration: abort on recompose/dispose, superseded loads dropped (hydration/src/scheduler.ts `retain`/`reload`, controller.ts `dispose`). Planner: "`plan()` receives none [no cancellation signal]" (planner/src/controlPlane.ts:15-17) | The planner turn cannot be interrupted by the UI (user types a new message mid-plan). loom-ui planner SPI must take `AbortSignal` and the model SPI must forward it |
| Back-pressure when agent emits faster than UI renders | ❌ | - | `update()` is synchronous, full-blueprint swap, non-re-entrant (renderBlueprintDom.ts:55-56); no rAF/microtask coalescing (grep: no requestAnimationFrame in renderer-lit/src) | Needs an update scheduler (coalesce to latest blueprint, frame-aligned), plus a store-side value coalescer. loom-ui renderer-lit |
| Determinism / replay of what the user saw | ⚠️ | P (structure) / ❌ (data) | Structure: Blueprint is a pure function of (experience, catalogue, surface, locale) (core/src/compile.ts "Pure and deterministic"); planner decision recorded (decision.ts `planDecisionId`, reference.ts:109 policy). Data: hydration is "transient; never persisted" (hydration/src/projection.ts:197, header :4-9) | The layout is replayable; the VALUES shown are not recorded anywhere, so "what exactly did the user see at 10:03" cannot be reconstructed. Placement: loom-ui should define an optional "frame snapshot" (blueprint ref + values digest or content-addressed values) and loom ctx.decide/event store keeps it; app opts in |
| Atomicity of partial hydration | ✅ | P | Each handle independent; failures surface as per-handle `error` status, never throw (hydration/src/scheduler.ts header; projection.ts status fold) | none |

**How an app drives a turn today:** user text -> `planner.revise({experience, request}, ctx)` (wait for full reply) -> returns ONE `prompt` op wrapping materialized primitives (reference.ts:231-245) -> `replay`/`apply` -> `seal` -> `compile` -> `handle.update(blueprint)` -> `controller.recompose(exp)`. Works, but is whole-reply, ~seconds, not streaming.

**Planner limits that cap the hot path:** drafts are ≤24 nodes (planner/src/contract.ts:13), a FLAT list under the root; containers are never authored by the planner and nested content is shown as `locked` placeholders (planner/src/prompt.ts:164-168; materialize.ts "the planner only authors semantic nodes"); a revise must echo the FULL node list (REVISE_SYSTEM: "Reply with the FULL desired node list"; "Omitting a node removes it") so the token cost per turn is O(nodes) and an agent cannot do cheap surgical edits via the reference planner.

---

## 2. AMBIENT EXPERIENCE RUNTIME

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Content-addressed versions, tamper detection | ✅ | P | `mintVersionHash` core/src/log.ts:40-43; `getExperience` returns `artifact-tampered` on mismatch (log.ts ~:117); `parents` inside the hash (core/src/experience.ts:80-90) | none |
| Version graph / lineage store / head pointer / history listing | ❌ | - | No function lists versions, resolves "latest", or walks parents; `next()` sets `parents` (operations.ts:131-141) but nothing reads them; no undo/redo/revert in core (grep) | Needs a `LineageStore` (head per experienceId, CAS advance, list/walk, branch). loom-ui (new package) over loom ContentStore + event log; app today |
| Ops log recorded with provenance | ⚠️ | Pr | `RecordedOperation {op, by: Provenance, at}` (operations.ts:112-116); `EXPERIENCE_COMPOSED {ref, parents, ops}` payload type (log.ts:21-25) | Only the TYPE. Nothing builds/emits/validates the event, nothing replays from stored ops. Ops are not in the hash, so the stored ops can disagree with the artifact undetected. loom-ui |
| Background recomposition by agents | ⚠️ | Pr | Planner `revise` (reference.ts:117) + `reviseForDrift` (planner/src/drift.ts:268) are callable from any loom flow; `prompt` op records the instruction | No trigger/scheduler/sentinel integration, no "revise while the user is looking" rebase. Each revise needs a SEALED base (reference.ts:121-136 `unsealed-base`). Placement: loom (sentinel/schedule) + app; loom-ui could ship an `ambientReviser` helper |
| Node identity preserved across recompose | ✅ | P | Widgets keyed by id; containers by layout id (IR 2.4) + type + role; focused subtree never moved (renderer-lit/src/dom/reconcile.ts:68-110, 145-200); core `preservesNodes` re-export (core/src/identity.ts:5) | Planner output ids are model-chosen `snake_case` (contract.ts DRAFT_ID) with no stability guarantee across revises beyond "keep byte-identical" in the prompt; no code checks that a revise preserved ids of untouched nodes (`preservesNodes` is available, not invoked in `ReferencePlanner`). loom-ui planner |
| State preservation across recompose | ⚠️ | Pr | Widget `patch` hook keeps DOM state when node props change (renderer-lit/src/dom/registry.ts:30-37); remount otherwise, reported in `RecomposeReport.remounted` | State is the widget's own DOM state; there is no framework-level UI state store (scroll, expanded rows, tab step survive only if the widget keeps them). Container role change or type change remounts (reconcile.ts doc). loom-ui |
| Hydration on read (split/contract) | ✅ | P | In-process `HydrationController` (hydration/src/controller.ts), server/client split with keyed revisions (hydration/src/split/server.ts:41-107, client.ts:171-260); per-principal store isolation (projection.ts:92-105); `serveHandle` refuses mismatched `versionHash` (server.ts:467-470) | none for read path |
| Transient vs durable | ✅ (by design) | P | hydration transient (projection.ts:197); durable repair via `remapProvider` + `SCHEMA_REPAIRED` (hydration/src/repair.ts) | Repair only for INPUT drift; output drift returns `repair-needs-planner` (repair.ts:34-43) |
| Caching / TTL | ✅ | P | `HydrationCache` keyed by spec fingerprint+params+principal, TTL via injected clock (hydration/src/cache.ts:92-140) | In-memory only; no shared/persistent cache, no stale-while-revalidate (an expired entry is just deleted: cache.ts get). loom-ui/app |
| Live data / refresh over time | ❌ | - | Handles are asked once per question (scheduler header); only `invalidate`/`setParams`/`recompose` re-ask; no poll/subscribe/push provider kind (grep: no setInterval/poll in hydration) | An ambient dashboard that stays fresh needs provider-level refresh intervals or push (loom read-model/live-query). loom-ui hydration + loom live-query |
| Staleness / drift detection and repair | ✅ | P | Tool schema pin + output shape/contract drift -> `stale` status + `onDrift` report (controller.ts:56-63,127-150); planner `reviseForDrift` (drift.ts:268); `observedSample` tainted sample | Good. Gap: a drift report is an in-process callback; nothing durable queues repairs for a user who isn't present. loom (sentinel) + app |
| Notification / attention ("this experience changed") | ❌ | - | No notification, unread, diff-summary or change-feed API. `EXPERIENCE_PROMOTED` payload exists (interaction.ts:77-83) but nothing consumes it. The `prompt` op carries the agent's text and the `PlanResult` has a model summary only inside prompt JSON, which is dropped (reference.ts:231) | Needs: a version-diff (`describeChange(prev,next)` from ops, using identity report), attention levels, and a delivery seam. loom-ui core (diff) + app/3P (channels) |
| Multi-device / multi-session | ❌ | - | Stores are per (experience, principal) (projection.ts:92-105) but no session/device notion, no sync of working state, no shared view-state; split hydration is stateless server (good for multi-device read) | Read is multi-device-safe by construction; write/sync/presence is absent. app + loom |
| Offline | ❌ | - | Client entry is browser-safe (hydration/src/split/client.ts header) but no cache persistence, queue or replay of actions | app; loom-ui could add a persistent cache adapter |
| GC / retention of old versions | ❌ | - | No pinning/retention code in loom-ui; every version stores the whole tree (putExperience stores full canonical bytes, log.ts:68-90), no structural sharing or delta storage | Storage O(versions x nodes). loom has `sweepUnpinnedContent` for composed surfaces (not used here, grep). loom-ui must expose `pins(exp)` for retention |
| Access control per experience / audience | ⚠️ | Pr | `Sensitivity` on bindings is carried to the Blueprint but "nothing in this package enforces it" (core/src/node.ts:27-30); hydration principal isolation + cache scope `principal` (cache.ts); `intent.objective` is the default Blueprint title and can leak (compile.ts `title` option doc) | No audience projection (compile-for-viewer that drops/redacts nodes above the viewer's clearance), no per-experience ACL. loom-ui core (audience filter at compile) + loom authz |
| Time/lifecycle (expiry, archive, supersede) | ❌ | - | none | app |

---

## 3. MULTI-TURN (conversation, transcript, input back to agents)

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Chat surface / transcript widget | ❌ | - | `Surface = "web" \| "terminal" \| "chat"` (core/src/catalog.ts:22) but "chat" is only a type literal: no kind, no renderer, no compile path (grep "chat" in src: only that line and a comment-free type) | A `chat` surface that resolves to messages (text/markdown/tool-call/approval) is promised by the type and absent. loom-ui (catalogue kinds + both renderers) |
| User input back to agent (forms/actions) | ⚠️ | Pr | `WidgetAction {type, widgetId, payload}` (loom blueprint-runtime/src/types.ts:173); `interpretAction` splits `experience.op` (user direct manipulation) from business actions (planner/src/interaction.ts:42-83) | Only a button-ish ApprovalCard and A2UI Button exist as inputs. No text input, select, form, file-upload kinds in the registry (renderer-lit/src/dom/litRegistry.ts:63-87; examples supply `NoteInput` themselves). loom-ui (kinds) |
| A2UI/Sandbox actions reach `onAction` | ❌ (inconsistent) | Pr | `lu-a2ui-view` and `lu-sandbox` raise a DOM `a2ui-action` CustomEvent (renderer-lit/src/widgets/lu-a2ui-view.ts:91, lu-sandbox.ts:97); `LuA2UIWidget`/`LuSandboxWidget` never forward to `this.onAction` and carry no widget id (lu-embedded.ts:25-63) | Two different action channels; actions from embedded views bypass `interpretAction` and the WidgetAction path. Bridge in `elementRenderer` (litRegistry.ts:11-35) is missing. loom-ui renderer-lit |
| callFunction / bidirectional RPC | ❌ in loom-ui | - | No reference to callFunction in loom-ui src (loom ADR 0070 lives in loom plugin-a2ui) | Wiring is app + loom; loom-ui provides no kind that issues or answers a call |
| Turn-level history / editing previous turns | ⚠️ | Pr | Each revise is one `prompt` op with the text and `materialized` primitives (operations.ts:104-110), so a transcript can be derived from the ops log | No API: "edit turn k" (rebase later ops), "regenerate", branch from turn. `prompt` op is not tied to its `decisionId`/`PlanReport` (op has `text`, `scopeNodeIds`, `materialized` only). loom-ui core (add decisionId to `prompt`) + app |
| Scoped revision ("only these nodes") | ✅ | P | `request.scopeNodeIds` (planner/src/spi.ts ReviseInput; prompt.ts SCOPE line) | none (enforced only in prompt, not by op validation: a model can touch out-of-scope nodes and `materialize` will accept; confirm in materialize.ts, not found enforcing scope) |

---

## 4. MULTI-AGENT

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Per-op attribution | ✅ | Pr | `Provenance {source, agentId, modelId, ref}` on each `RecordedOperation` (operations.ts:31-37,112-116) | Attribution lives outside the hash and outside the artifact (operations.ts header; `meta.author` is one string for the whole artifact, experience.ts:75). |
| Per-node provenance / "who wrote this node" | ❌ | - | `SemanticNode` has no author/agent/decision field (core/src/node.ts:69-90); `experienceArtifact` hashes no authorship (experience.ts:88-99) | A node-level `provenance`/`decisionRef` (hashed or sidecar index) is needed for explain-this-widget and multi-agent trust. loom-ui core |
| Concurrent edits / merge of ops / conflict resolution | ❌ | - | `apply(base, op)` has no base-version precondition (operations.ts:258); no `merge`/`rebase`/`transform` (grep); order keys claim "Two authors inserting siblings concurrently mint non-colliding keys without coordination" (core/src/order.ts:4-5) but `orderKeyBetween` is a deterministic midpoint (order.ts:10-22), so two authors inserting between the same neighbours mint IDENTICAL keys (claim not backed by code; sibling order then falls to array order) | Needs op rebasing over the parents DAG, id-collision handling, tie-break order keys (e.g. random suffix). loom-ui core |
| Region ownership / locking | ⚠️ | Pr | Planner treats direct-child containers as "locked: belongs to the application" (planner/src/prompt.ts:164-168, REVISE_SYSTEM) and `materialize` refuses edits inside them (materialize.ts:385,542-560); `interpretAction` bars root/provider/role ops for widgets (interaction.ts:42-83) | Ownership = "planner vs app", fixed by structure. No named agent leases, no per-region policy, no capability per node subtree. loom-ui core (node `owner`) + loom authz |
| Agent status / activity views | ❌ | - | Kinds: Timeline, ProgressBar, StatusCard exist as generic data widgets; no agent-activity kind, no live presence | A 'who is working on what' kind + store contract. loom-ui catalogue / app |
| Delegation visibility | ❌ | - | loom DecideScope carries delegation (planner/src/spi.ts:40-47) but nothing shows it in UI | loom-ui kind + loom events |

---

## 5. MULTI-MODAL

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Image / audio / video / file / map / canvas / 3D widgets | ❌ | - | The complete kind set: MetricCard, StatusBadge, DataTable, TimeSeries, BarChart, Kpi, Table, StatusCard, Note, A2UIView, SandboxView, ProgressBar, AlertCard, StreamingText, Timeline, ApprovalCard (renderer-lit/src/dom/litRegistry.ts:63-87). A2UI vocabulary is Text/Badge/Column/Row/List/Button only (lu-a2ui-view.ts:5-8) | Apps must register their own kinds (the registry is open, examples do) but loom-ui ships none and its value-contract layer has no media types. loom-ui catalogue + both renderers; SandboxView is the escape hatch (CSP default-src 'none' blocks network, so remote media cannot load inside it: sandbox/protocol.ts header) |
| Binary content via content store (claim-check) | ❌ | - | The content store is used ONLY to persist experience bytes (core/src/log.ts). Hydrated values are in-memory JSON in the projection (hydration/src/projection.ts); no `ContentRef` value kind, no blob resolver in the renderer | A `ContentRef` value contract + a resolver seam (signed URL / fetch via principal) so bound values stay small. loom-ui core+hydration (+ loom plugin-content) |
| Streaming media | ❌ | - | none | app / 3P kind |
| Input modalities (voice, camera, upload) | ❌ | - | No input widget besides approve/reject buttons | loom-ui kinds + renderers; browser capabilities are app side |
| Accessibility | ✅ (web) / ⚠️ (parity) | P | Every widget has `role="group"` + a spoken `aria-label` per state (base.ts:139-190, a11y.ts), `role="status"` live region on empty/status card (base.ts, lu-status-card.ts:89), screen-reader description of degrade (base.ts `sourceLabel`), i18n/plural/RTL helpers (renderer-lit/src/i18n.ts, plural.ts, rtl.ts), chart text alternatives (chartDescription tests) | No keyboard model for the table/charts beyond native controls; no reduced-motion handling (grep prefers-reduced-motion: none); terminal has no a11y notion. loom-ui |

---

## 6. AUTONOMY & OVERSIGHT

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Planner SPI + reference + conformance | ✅ | P | `Planner {compose, revise}` (planner/src/spi.ts:140-151), `ReferencePlanner` with retries and findings (reference.ts), `checkPlannerConformance` (planner/src/conformance.ts:207-472: ops-not-experiences, replay, decision replay without model, scope/denial probes) | Reference planner limits (flat, ≤24 nodes, full echo, no streaming, no signal) cap it; the SPI itself allows richer planners |
| Catalogue validation of what a planner may render | ✅ | P | Model output schema derived from catalogue: unknown type/prop, binding rule, capability allow-list all schema issues (planner/src/contract.ts:55-130); `validateExperience`; plan loop retries only on findings (reference.ts:213-249) | none |
| Sensitivity from the model | ✅ | P | A model may set a binding's class only where the entry says `model-may-set` (contract.ts:119-128) | Not enforced at render/hydrate time (node.ts:30) |
| Control-plane errors never recorded as decisions | ✅ | P | planner/src/controlPlane.ts:23-53 (CapabilityDenied, Quota, Abort, Untrusted...) | none |
| Untrusted content / taint into UI | ⚠️ | Pr | Prompt fences tool-authored text as DATA with backtick escaping and truncation (prompt.ts `fenceData` ~:48-75); `observed` samples are `TaintedValue` (spi.ts ReviseInput); renderers use Lit text interpolation, not `unsafeHTML` (grep found none) and the one `innerHTML` path (tooltip) escapes every interpolated value (renderer-lit/src/tooltip.ts:51 + lu-timeseries.ts:258-279 `escapeHtml`) | Taint stops at the planner; hydrated values are not taint-wrapped when they reach widgets, and Note/StreamingText render model/tool strings with no markdown/link policy (safe today because there are no links/images, which is also a capability gap) |
| Sandbox for untrusted render code | ✅ | P | null-origin iframe `sandbox="allow-scripts"`, CSP `default-src 'none'`, marker + `event.source` check, height clamp (renderer-lit/src/sandbox/protocol.ts header; widgets/lu-sandbox.ts:20-60, MAX_FRAME_HEIGHT) | `postMessage(..., "*")` is justified by null origin; frame has no kill/timeout (a spinning script freezes only its frame, but nothing disposes it on CPU abuse). loom-ui |
| Human-in-the-loop: approvals | ⚠️ | Pr | `ApprovalCard` APPROVE/REJECT actions (lu-simple.ts:159-199) and loom's suspend gate on the app side | The action carries ONLY `widgetId` and `approved`; no `blueprint.id@versionHash`, no nonce (lu-simple.ts:184-186). So an approval click on an outdated view is indistinguishable from a current one. Stale-view protection is absent at the action layer, even though `blueprint.id` is `experienceId@versionHash` (compile.ts:123) and the split server checks `versionHash` for DATA (server.ts:467). loom-ui renderer (stamp action with blueprint id) + app (compare to head) |
| `experience.op` interaction guard | ✅ | P | `interpretAction` refuses prompt/provider/setRole/root ops, checks node exists (interaction.ts:42-83) | Does not check the base version (`apply` always on the app's current `exp`), so a delayed drag on a node that was since replaced applies silently |
| Explanation / provenance of why the UI looks this way | ⚠️ | Pr | Every plan is one `ctx.decide` with `PlanReport {decisionId, attempts, usage, modelId, firstAttemptValid}` (spi.ts:114-135); `source.degradedFrom` chain is carried onto widgets and spoken (compile.ts degrade; base.ts `degradedChain`) | The `PlanReport`/decisionId are not linked to the resulting nodes or ops (`prompt` op omits decisionId, operations.ts:104-110); the model's `summary` (user-facing "what I changed") is parsed then discarded (contract `PlanDraft.summary` is not returned in `PlanResult`). No "Why this widget?" API. loom-ui planner+core |
| Guardrails: size bounds | ✅ | P | MAX_TREE_DEPTH=256 checked before any recursive work (node.ts, operations.ts:260-285, log.ts getExperience), draft ≤24 nodes, retry cap, fence truncation 8000 chars | none |

---

## 7. LEARNING (signals, decisions, personalization, A/B, evaluation)

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Capture user feedback/interaction as signals | ❌ | - | grep for feedback/reward/impression/telemetry/experiment in all four src dirs: zero hits. `WidgetAction` is the only inbound channel | loom-ui should define a typed signal event (impression, dwell, dismiss, edit-after-plan, accept/reject of a plan) emitted from the renderer; loom records it. loom-ui renderer-lit + core types, loom event |
| Link signals to planner decisions | ⚠️ | Pr | Each plan is a `ctx.decide(decisionId, ..., {policy: REFERENCE_POLICY})` (reference.ts:100-114) so the DECISION_RECORDED exists | The decisionId is not propagated to the ops/nodes/Blueprint, so a click cannot be joined to the decision that produced the widget. `policy.propensity` is accepted by `DecideOptionsLike` (spi.ts:35) but the reference planner never sets it, so off-policy evaluation is impossible. loom-ui planner |
| Personalization / operator profile | ⚠️ | Pr | `context` input is "resolved and recorded by the caller", rendered as fenced data (spi.ts ComposeInput) and included in the decision key (decision.ts) | No profile type, no derivation, no expiry semantics. app + loom-ui planner guidance |
| A/B or canary of planner policies/layouts | ❌ | - | `REFERENCE_POLICY` is a constant id/version (reference.ts:44); no policy selection, no variant assignment | loom has `decideWithPolicy`; loom-ui planner should accept a policy chooser and stamp the arm on the plan |
| Evaluation of generated UIs | ⚠️ | Pr | `PlanReport.firstAttemptValid` + usage per plan (spi.ts:114-135) give regression rates; conformance kit checks contract | No quality metric (renders without findings? user accepted?), no golden/judge harness for generated layouts. loom-ui planner (eval kit) |

---

## 8. RENDERERS & REACH

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| renderer-lit (web components) | ✅ | P | Keyed reconcile, container roles (stepped/tabs via role registry), status matrix, charts, a11y (see sections 1-5) | Full-tree `deepEqual` per update (reconcile.ts:149) and no virtualization (grep: none) |
| renderer-terminal | ⚠️ | Pr | 390 lines; delegates traversal to loom's terminal renderer; `watch` re-renders the WHOLE string on every projection change (renderer-terminal/src/watch.ts:10-13) | Read-only, no actions/input, no incremental frame; fine as a status view, not an interactive TUI |
| React / native / mobile / voice / AR renderers | ❌ in loom-ui | - | loom ships `plugins/renderer-react` (a different registry); loom-ui has none. Voice/AR: nothing | 3P or loom-ui; Surface is a closed union of 3 literals (catalog.ts:22) so a new modality needs a core change, not a plugin |
| Renderer SPI | ✅ | P | `DomWidgetRenderer`/`DomContainerRenderer` contracts with `update/patch/dispose` (renderer-lit/src/dom/registry.ts:13-95); loom `RendererRegistry` + `catalogCoverage` (compile.ts `registry` option -> `renderer-coverage` finding) | DOM-specific: a non-DOM 3P renderer implements loom's registry, not this |
| Renderer conformance kit | ❌ | - | `checkPlannerConformance` exists; no renderer equivalent in loom-ui (grep "conformance" in renderer-* packages: none) and none in loom (checked packages/ and plugins/) | A kit asserting: status-matrix rows, keyed-recompose identity, patch-not-clobber-user-state, action shape, a11y name per state. Parity today rests on identical hand-copied tables + two test files. loom-ui |
| Parity web <-> terminal | ⚠️ | Pr | Same status matrix pinned by twin tests (base.ts header; statusMatrix.test.ts in both) and the same value contracts (`checkKindValue` shared) | Terminal drops interactivity, container roles and a11y; ApprovalCard is a loom terminal kind |
| MCP Apps / A2UI | ⚠️ | Pr | A2UIView renders Google-A2UI-like trees (renderer-lit/src/a2ui/plan.ts) and the sandbox; no code in loom-ui to emit an Experience as an MCP App or A2UI surface (loom has plugin-mcp-app/a2ui) | A projection `Experience -> A2UI surface/MCP App` would make loom-ui a source of truth for 3rd-party hosts. loom-ui or loom plugin |
| Layout vocabulary | ✅ | P | 12-col grid with row/rowSpan/column placement, flex, containers with titles/roles (core/src/node.ts:35-90) | no responsive/breakpoint model; no overlays/drawers/modals |

---

## 9. SCALE & ROBUSTNESS

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Thousands of nodes: model/ops/compile | ✅ | P | apply 0.5 ms, compile 8 ms at 5,000 nodes (measured); ops iterative where recursion matters (operations.ts `treeDepth`, `locate`) | `findNode` is O(n) per lookup and each `apply` rebuilds the tree (operations.ts rebuild; node.ts:279) so an N-op batch is O(N x n) and `replay` of a long log from genesis is O(ops x n); no snapshotting inside the log. fine to ~10^4, not 10^6 |
| Sealing cost | ⚠️ | Pr | 235 ms at 5k nodes (measured); `seal` re-parses via zod and canonicalises the whole tree (log.ts:40-60) every call | Cost is per-turn not per-op; acceptable for agent turns, not for keystroke-level ops. loom-ui |
| Render performance | ⚠️ | Unmeasured | Per-update `preservesBlueprintNodes` + `malformedNodes` + `reconcileRoot` + `deepEqual` over the full tree (renderBlueprintDom.ts:137-160; reconcile.ts:149); one custom element + shadow root per widget; no virtualization, no lazy mount; `markVisible` (P2 lazy loading) is NEVER called by renderer-lit (grep: no IntersectionObserver or markVisible in renderer-lit/src), so a P2 handle stays loading unless the app adds its own observer (one consumer app does; loom-examples does not) | Unmeasured in a browser (no build allowed); structural O(n) per update. loom-ui renderer-lit (visibility reporting + virtualization) |
| Op log / version storage growth | ❌ | - | Full tree per version; no compaction, snapshots, or retention (see 2) | loom-ui + loom content GC |
| Failure surfacing | ✅ | P | All APIs return `Finding`s, not exceptions: `artifact-missing/invalid/tampered/unhashable` (log.ts), `RecomposeReport.findings` (registry.ts), per-widget error placeholder (base.ts), `projectionPlaceholder` (registry.ts:123-136), tree-too-deep refusal at every entry (compile.ts:96-117, controller.ts:156-160) | Findings are not durable; no aggregated health view of an ambient experience over time |
| Memory | ⚠️ | Pr | `HydrationCache` has TTL expiry on read only; entries for never-re-read keys never evicted (cache.ts get/set), no size cap; `fingerprints` WeakMap OK | Unbounded cache growth in a long-lived ambient host. loom-ui hydration |
| Hostile/untrusted data in tree | ✅ | P | depth cap before zod, `__proto__` handled in store/ops (projection.ts RESERVED, operations.ts removeProvider), bounded echoes | none |

---

## 10. Doc/claim vs code mismatches found

1. core/src/order.ts:4-5 says concurrent authors "mint non-colliding keys without coordination"; `orderKeyBetween` is deterministic (order.ts:10-22), so two authors inserting between the same pair get the same key. Not backed by code.
2. renderer-lit `StreamingText` kind (litRegistry.ts:82, lu-simple.ts:93) and the `Surface = "chat"` literal (catalog.ts:22) suggest streaming and chat support; neither exists beyond the name/type.
3. `EXPERIENCE_COMPOSED` / `EXPERIENCE_PROMOTED` read like a persistence protocol (log.ts:12-25, interaction.ts:75-83) but are constants + payload types only; no producer, consumer or validator in the repo.
4. `Sensitivity` is declared as carried to "an audience check downstream" (node.ts:27-30); no such check exists in loom-ui (the file itself says so).
5. `A2UIView`/`SandboxView` are registered as widget kinds (litRegistry.ts:53-60) whose actions do not use the `WidgetAction` contract (lu-a2ui-view.ts:91, lu-sandbox.ts:97).

---

## 11. Verdict by mode

**Mode 1, hot path:** the *data model* is excellent for it (pure ops, 0.5 ms apply/8 ms compile at 5k nodes, never-throw findings, keyed focus-preserving recompose). The *driving loop* is not: no streaming planner, no cancellation, no coalescing, planner capped at 24 flat nodes with full-list echo. It supports "agent replies, then UI updates" at seconds latency, not "UI materialises as the agent thinks".

**Mode 2, ambient:** the *artifact and read path* are strong (content addressing, tamper detection, split hydration with principal isolation, drift detection, planner repair loop). The *runtime* is missing: no lineage/head/history, no change notification, no refresh/push, no retention, no audience projection, no multi-device state, no durable ops-log protocol. A team would build ~5 new components on top.

## 12. Top gaps ranked (what blocks futuristic agentic UIs most)

1. Streaming/incremental UI: no streaming planner SPI, no partial-op fold, no token-append values (loom-ui planner/core/renderer; loom ctx.decide must record streams).
2. Experience lineage runtime: no head pointer, version listing, branch/undo, ops-log protocol (EXPERIENCE_COMPOSED has no producer) (loom-ui new package over loom store).
3. Ambient change delivery: no diff/summary of what changed, no attention/notification seam, no live-refresh/push providers (loom-ui core diff + hydration refresh; loom read-model/live-query; app channels).
4. Concurrency: no base-version precondition, op rebase/merge, order-key tie-break, per-node ownership (loom-ui core).
5. Stale-view/approval safety at the action layer: actions carry no `blueprint.id`/versionHash; embedded A2UI/sandbox actions bypass `WidgetAction` (loom-ui renderer-lit + app).
6. Chat/multi-turn surface and input kinds: `chat` surface is a type only; no text/form/select/upload kinds; no turn-edit API; `prompt` op not tied to decisionId (loom-ui core+catalogue+renderers).
7. Multi-modal vocabulary and claim-check values: no image/audio/video/map/canvas kinds, no ContentRef value contract (loom-ui core+hydration+renderers; loom plugin-content).
8. Learning loop: zero signal capture, decisionId not joined to nodes, propensity never set, no policy variant selection (loom-ui renderer+planner; loom learning).
9. Audience/ACL enforcement: Sensitivity declared but unenforced, no compile-for-viewer redaction, default Blueprint title leaks intent (loom-ui core + loom authz).
10. Scale/retention: full-tree version storage, no GC/pins/snapshots, `markVisible` never called by the renderer, no virtualization/update coalescing, unbounded hydration cache (loom-ui renderer-lit + hydration; loom content GC).

Also notable (below top 10): no renderer conformance kit; planner turn not cancellable; per-node provenance and "why this widget" explanations absent; hydrated VALUES are not recorded so what the user saw is not replayable.
