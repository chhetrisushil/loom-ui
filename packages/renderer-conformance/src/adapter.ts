import type { LuI18n } from "@loom-ui/core";
import type { BindingState, Blueprint, WidgetAction } from "@loom/blueprint-runtime";

/**
 * What a renderer must implement for the kit to drive it. The kit hands it a loom `Blueprint` plus
 * the values bound to it and asks it to show them; it reads back what a viewer could READ (text),
 * and optionally drives it (update, invoke). Nothing here names a framework: a Lit element tree, a
 * terminal frame, a React tree rendered to a string, or the sentences a voice assistant would speak
 * all satisfy it.
 */

/** The state of one hydration handle: the bound value and its delivery status. */
export interface HandleEntry {
  readonly value?: unknown;
  /** Absent = no status channel has landed yet (the widget is loading when there is no value). */
  readonly state?: BindingState;
  /** The status finding's message, for `error` / `empty` / `stale`. */
  readonly message?: string;
}

export interface MountOptions {
  /** Hydration handle -> its entry. The Blueprint's bindings read these through the hydration projection. */
  readonly values: Readonly<Record<string, HandleEntry>>;
  /** Every `WidgetAction` the renderer emits, in order. May return an `ActionOutcome`. */
  readonly onAction: (action: WidgetAction) => unknown;
  /** The host's words and locale. Only passed to an adapter that declares `capabilities.i18n`. */
  readonly i18n?: LuI18n;
}

/** A live mounted view. */
export interface MountedRenderer {
  /**
   * Everything a viewer can READ right now, as one string: visible text plus accessible names. It
   * SETTLES first (await any scheduled render) so the kit never sleeps. Order is reading order.
   */
  text(): string | Promise<string>;
  /** Publish a handle's new value / status, as the hydration store would. */
  set(handle: string, entry: HandleEntry): void | Promise<void>;
  /** Land a revised Blueprint on the live view (incremental render). Needs `capabilities.update`. */
  update?(next: Blueprint): void | Promise<void>;
  /** Drive a control the way a viewer does. Needs `capabilities.invoke`. */
  invoke?(widgetId: string, intent: InvokeIntent): void | Promise<void>;
  /** Release subscriptions. After it, `set` must not throw and must not change what was last shown. */
  dispose(): void;
}

/** What a viewer does to a control; the renderer maps it to its own gesture (click, key, utterance). */
export type InvokeIntent =
  | { readonly kind: "approve" }
  | { readonly kind: "reject" }
  | { readonly kind: "select"; readonly value: string }
  | { readonly kind: "text"; readonly text: string };

export interface AdapterCapabilities {
  /** `update(next)` is incremental and keeps the view live. */
  readonly update?: boolean;
  /** `invoke` drives APPROVE / REJECT / SELECT / SUBMIT_TEXT controls. */
  readonly invoke?: boolean;
  /** `mount` honours `MountOptions.i18n` (the host's words and locale). */
  readonly i18n?: boolean;
  /**
   * The surface INTERPRETS control characters (a terminal reads ESC sequences; a speech engine
   * reads markup), so none of an untrusted text's may reach it. A DOM text node is inert and leaves
   * this off. Whatever the surface, markup in a text is always shown as the literal characters.
   */
  readonly interpretsControlCharacters?: boolean;
}

export interface RendererAdapter {
  /** Shown in reports. */
  readonly name: string;
  /**
   * The catalogue surface this renderer draws (`"web"`, `"terminal"`, `"voice"`…): the key under
   * which a semantic entry's `surfaces` names the Blueprint kind it resolves to.
   */
  readonly surface: string;
  /**
   * The Blueprint kinds this renderer DRAWS. A kind of the kit's fixtures that is not listed must be
   * REFUSED visibly (its title or kind name on the surface), never silently dropped.
   */
  readonly kinds: readonly string[];
  readonly capabilities?: AdapterCapabilities;
  /** Mount `blueprint`. Each call is independent (a fresh store and host). */
  mount(blueprint: Blueprint, options: MountOptions): MountedRenderer | Promise<MountedRenderer>;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** Why it failed, or why it was skipped. */
  readonly message?: string;
}

export interface ConformanceReport {
  readonly adapter: string;
  readonly results: readonly CheckResult[];
  /** No check failed. A skip does not fail the report; see {@link ConformanceReport.skipped}. */
  readonly ok: boolean;
  readonly failed: readonly CheckResult[];
  readonly skipped: readonly CheckResult[];
}
