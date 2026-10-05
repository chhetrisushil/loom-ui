# loom-ui — genericity, optionality & agentic-readiness evaluation (2026-10-05, loom-ui main 0b58739)

Fresh, code-only audit (no prior evaluations, docs or ADRs used as evidence): [E — genericity & optionality](2026-10-05-agentic-readiness-genericity-optionality.md)
and [F — futuristic readiness](2026-10-05-agentic-readiness-readiness.md), every claim citing `path:line`. Re-verified in code: loom has no
`@loom-ui/*` dependency (no package.json entry, no non-test import); `Surface` is the closed union `"web" | "terminal" | "chat"`;
a compiled Blueprint only ever names the hydration projection; `EXPERIENCE_COMPOSED` is a constant with no producer in loom-ui;
`markVisible` is never called by renderer-lit; and `orderKeyBetween` is deterministic — two authors inserting between the same
siblings both mint `"c"`, contradicting `core/src/order.ts`'s "non-colliding keys without coordination". The second-consumer
rule was relaxed for this evaluation.

## Verdict

**Optional: yes, fully. Generic: mostly. Ready for futuristic agentic UIs: not yet.** loom-ui is a strong, pure
*view / compile / hydrate / plan library* — not yet a runtime. Its artifact model (content-addressed, tamper-evident
Experiences; pure op replay; never-throw findings; keyed, focus-preserving recompose; split hydration with per-principal
isolation; drift repair) is sound. What's missing is (1) the runtime around it — lineage, change delivery, concurrency,
streaming — and (2) vocabulary beyond read-only observability dashboards: chat, input, media.

| Dimension | Verdict | One line |
|---|---|---|
| Optionality | ✅ | loom never depends on loom-ui; the reach contract is structural (`Symbol.for`); loom's own UI path (blueprint-runtime, React/terminal renderers, agent-surface, A2UI, MCP-app, live-query) is complete but minimal (8 widgets, ignores layout roles) |
| Genericity | ⚠️ mostly | No consumer names, vendor/LLM/CSS lock or domain nouns; open semantic types, renderers and roles. Leaks: MCP-only data plane in the artifact schema, bindings only to the hydration projection, closed `Surface` + value-contract registry, English-only renderer strings, an observability-shaped widget set |
| Hot-path UI | ⚠️ partial | Excellent data model; but the driving loop is whole-reply — no streaming planner, no partial ops, no cancellation; the reference planner is capped at 24 flat nodes and a revise echoes the full node list |
| Ambient experience runtime | ⚠️ partial | Artifact + read path strong; missing the runtime: no lineage/head/history, no change notification or live refresh, no GC, no multi-device state |
| Multi-turn | ❌ weak | `chat` is a type literal only — no chat kind or renderer, no input kinds beyond approve/reject, no edit-previous-turn |
| Multi-agent | ❌ weak | Provenance per op not per node (outside the hash); no base-version precondition, rebase or merge; colliding order keys; ownership only planner-vs-app containers |
| Multi-modal | ❌ absent | No image/audio/video/map/canvas/input kinds; content store used only for Experience bytes (no `ContentRef` value contract); a11y on web is strong |
| Autonomy & oversight | ✅ good | Planner SPI + conformance, catalogue-derived output schema, control-plane rethrow, null-origin sandbox, escaped tooltips. Gaps: stale-view protection on actions, node-level explanation, taint into widgets |
| Learning | ❌ absent | No signal capture; decision id not joined to nodes; reference planner never sets propensity; no policy variants or eval harness |
| Renderers | ⚠️ partial | renderer-lit solid; renderer-terminal read-only, whole-string re-render; no renderer conformance kit |
| Scale | ✅ model / ? DOM | 5,000 nodes: apply 0.5 ms/op, compile 8 ms, seal 235 ms; every update walks the tree; no virtualization/coalescing; unbounded hydration cache; full tree per version |
| Packaging | ❌ | All private 0.0.x, `@loom/*` as `"*"` via sibling links, no peer deps/`files`/`sideEffects`, mixed CJS/ESM, no runnable quickstart; no runtime IR/compat check |

## Prioritised gaps

### P0 — blocks futuristic agentic UIs or is incorrect
| # | Gap | Placement |
|---|---|---|
| U1 | **Streaming / incremental UI**: a streaming planner SPI, partial-op folding, token-append values (`StreamingText` is a plain string), cancellation | loom-ui planner/core/renderers; loom `ctx.decide` recording of streams |
| U2 | **Bindings beyond the hydration projection**: let nodes bind any loom projection (agent status, approval queues, transcripts) — the IR already allows `projectionId`/`path` | loom-ui core |
| U3 | **Pluggable data plane**: the artifact schema and hydration are MCP-only; a provider SPI (MCP as one implementation) | loom-ui core + hydration |
| U4 | **Concurrency correctness**: colliding `orderKeyBetween` keys (fix the comment's promise: author-salted keys), base-version precondition on `apply`, rebase/merge of ops, per-node ownership | loom-ui core |
| U5 | **Action-layer safety**: stale-view protection (actions carry the version the user saw); A2UI and sandbox actions bypass `WidgetAction`/`onAction` | loom-ui renderer-lit + app |

### P1 — needed for credible ambient, conversational and multi-agent UIs
| # | Gap | Placement |
|---|---|---|
| U6 | **Experience lineage runtime**: head pointer, version list, branch/undo, an ops-log protocol that actually produces/consumes `EXPERIENCE_COMPOSED`/`EXPERIENCE_PROMOTED` | new loom-ui package over loom stores |
| U7 | **Ambient change delivery**: version diff/summary, an attention/notification seam, refresh/push providers | loom-ui core/hydration + loom live-query/read-model |
| U8 | **Chat & input vocabulary**: chat kind + renderers, text/form/select/upload input kinds, write-back model, edit-previous-turn | loom-ui catalogue/core/renderers |
| U9 | **Multi-modal**: media kinds, a `ContentRef` value contract over loom's content store, input modalities | loom-ui core/hydration/renderers + loom plugin-content |
| U10 | **Audience/ACL enforcement**: `Sensitivity` is declared, never enforced; compile-for-viewer redaction; default title from `intent.objective` can leak | loom-ui core + loom authz |
| U11 | **Learning loop**: interaction signals → decision ids → rewards; propensity in the reference planner; policy variants; UI eval | loom-ui renderers/planner + loom learning |
| U12 | **Per-node provenance & explanation**: who/what produced a node and why; planner `summary` is parsed then dropped; hydrated values not recorded (what the user SAW isn't replayable) | loom-ui core/planner |

### P2 — generality, reach and robustness
| # | Gap | Placement |
|---|---|---|
| U13 | Open the closed vocabularies: `Surface`, kind value-contract registry (custom kinds pass `checkKindValue` vacuously) | loom-ui core |
| U14 | i18n host override; English a11y/empty strings; terminal hardcodes `en-US` | loom-ui renderers |
| U15 | Planner depth: beyond 24 flat nodes on a 12-col grid — tabs/steppers/nesting; revise as a diff | loom-ui planner |
| U16 | Renderer conformance kit; terminal interactivity + incremental render; a 3P renderer path (React/native/voice) | loom-ui |
| U17 | Scale: virtualization, update coalescing, bounded hydration cache, `markVisible` wired in renderer-lit, version snapshots/GC/pins | loom-ui renderer-lit/hydration + loom content GC |
| U18 | Layering: `planner`/`renderer-terminal` import the SERVER hydration entry (QuickJS + plugin-mcp for one helper/constant) → use `./client` | loom-ui |
| U19 | Packaging & compatibility: publishable packages, peer deps, `files`/`sideEffects`, one module format, runnable quickstart, runtime `BLUEPRINT_IR_VERSION` check, semver ranges | loom-ui (+ loom publishing) |
| U20 | Tree-shaking: renderer-lit registers every element on import; "studio" wording in comments; widen the genericity fitness regex | loom-ui |
| U21 | Optional: move renderer-lit's generic DOM adapter into loom as `plugin-renderer-dom`, so a loom app gets a web renderer without loom-ui | loom (1P plugin) |

## Doc/claim vs code mismatches
`order.ts` promises collision-free concurrent keys (measured: both authors get `"c"`); `StreamingText` and the `chat` surface imply
streaming/chat support that doesn't exist beyond the name; `EXPERIENCE_*` constants read like a persistence protocol with no
producer or consumer; `Sensitivity` is described as feeding "an audience check downstream" that doesn't exist; A2UI/sandbox
actions bypass the documented `WidgetAction` contract.

## Suggested sequencing
1. **Correctness first** (small): U4's colliding order keys + base-version precondition; U5 action-layer stale-view + unify A2UI/sandbox actions; U10 enforce `Sensitivity` or stop claiming it.
2. **Open the seams**: U2 any-projection bindings, U3 data-provider SPI, U13 open vocabularies, U18 layering — these unblock every app-specific extension without forking.
3. **The runtime**: U6 lineage + U7 change delivery (the ambient mode), U1 streaming (the hot-path mode) — one design pass with ADRs.
4. **Vocabulary**: U8 chat/input, U9 media, U15 planner depth.
5. **Learning, provenance, reach, packaging**: U11, U12, U16, U17, U19, U20, U21.
