import type { BindingState, Blueprint, WidgetAction } from "@loomwork/blueprint-runtime";
import type { LuI18n } from "@loomwork/ui-core";

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
  /**
   * Host content under a transcript entry, as TEXT (the kit's renderer-neutral stand-in for a surface's
   * own accessory seam, e.g. the web renderer's `chatAccessories`). `null` = nothing for that entry.
   * Only passed to an adapter that declares `capabilities.chatEntryAccessory`.
   */
  /**
   * Mount with NO host listening: the renderer is given no action handler (`onAction` is still passed so the kit can
   * count, but the adapter must not wire it). Only passed to an adapter that declares `capabilities.references`.
   */
  readonly unattended?: boolean;
  readonly chatAccessory?: (entry: {
    readonly id: string;
    readonly turn: number;
    readonly role: string;
    readonly status: string;
  }) => string | null;
}

/** A live mounted view. */
export interface MountedRenderer {
  /**
   * Everything a viewer can READ right now, as one string: visible text plus accessible names. It
   * SETTLES first (await any scheduled render) so the kit never sleeps. Order is reading order.
   * EVERY rendered attribute a viewer or assistive tech is given counts as read — values,
   * placeholders, link targets, data-* — not only visible text, so a hostile string hiding in one
   * is caught like any other.
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
  | { readonly kind: "text"; readonly text: string }
  /** Choose exactly these values of a `MultiSelectInput`, in this order, starting from an empty selection. */
  | { readonly kind: "select-many"; readonly values: readonly string[] }
  /**
   * Activate the `n`th (1-based) source marker of a widget whose value carries `refs`. Needs `capabilities.references`.
   * Where the widget has no such control (an unattended mount draws markers as text), the adapter must FAIL, never
   * pretend: the kit relies on it to know an inert marker is not a control.
   */
  | { readonly kind: "ref"; readonly n: number }
  /** Activate the token chip with this id in a `Table` cell (the first match in the widget). Needs `capabilities.tokens`. */
  | { readonly kind: "token"; readonly tokenId: string };

export interface AdapterCapabilities {
  /** `update(next)` is incremental and keeps the view live. */
  readonly update?: boolean;
  /** `invoke` drives APPROVE / REJECT / SELECT / SELECT_MANY / SUBMIT_TEXT controls. */
  readonly invoke?: boolean;
  /** `mount` honours `MountOptions.i18n` (the host's words and locale). */
  readonly i18n?: boolean;
  /**
   * The surface INTERPRETS control characters (a terminal reads ESC sequences; a speech engine
   * reads markup), so none of an untrusted text's may reach it. A DOM text node is inert and leaves
   * this off. Whatever the surface, markup in a text is always shown as the literal characters.
   */
  readonly interpretsControlCharacters?: boolean;
  /**
   * The renderer parses a `format: "markdown"` text part (core's `parseChatMarkdown`) and draws its structure. Every
   * renderer must pass the safety half of `chat-markdown` (markup literal, no unsafe link, no image address, a plain part
   * never parsed); this adds the check that the markdown source itself is not what a viewer reads.
   */
  readonly chatMarkdown?: boolean;
  /**
   * The renderer draws host content under a transcript entry (`MountOptions.chatAccessory`): with its
   * entry, after the entry's own text, never for a restricted entry. A surface without the seam leaves
   * this off and is only checked to draw the transcript unchanged.
   */
  readonly chatEntryAccessory?: boolean;
  /**
   * The renderer draws a TimeSeries' time axis as text, and labels it as a declared
   * `TimeSeriesValue.timeFormat` says (core's `formatTimeLabel`): each period as written, once. A
   * surface that draws no time labels (a sparkline) leaves this off and is only checked to accept
   * and draw a value that declares one.
   */
  readonly timeAxisLabels?: boolean;
  /**
   * The renderer draws a value's `refs` as numbered markers a viewer can ACTIVATE (needs `invoke`, and `mount` honours
   * `MountOptions.unattended`): activating one emits `REF_OPEN { refId, n }` for the widget, and with no host listening
   * the markers are not controls. A surface that cannot be clicked (the terminal, speech) leaves this off and is only
   * checked to accept and draw a value with refs, label text included, and to refuse a bad list.
   */
  readonly references?: boolean;
  /**
   * The renderer draws a `Table` token cell as controls a viewer can ACTIVATE (needs `invoke`): activating one emits
   * `TABLE_TOKEN { rowKey, tokenId }` (`{ rowIndex, tokenId }` for a table without `rowKeys`). A surface that cannot be
   * clicked leaves this off and is only checked to draw a token cell's labels as text.
   */
  readonly tokens?: boolean;
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
