import {
  CHAT_REF_OPEN_ACTION,
  type ChatEntry,
  type ChatPart,
  type ChatReasoning,
  type ChatValue,
  EDIT_TURN_ACTION,
  LOAD_OLDER_ACTION,
  LOAD_REASONING_ACTION,
  chatActorLabel,
  chatReasonText,
  chatSpeaker,
  chatStatusNote,
  describeMedia,
  isOwnChatEntry,
  mediaFamily,
  newSubmitKey,
  oneLineChatText,
  sanitizeChatText,
  splitRefMarkers,
  validateTextValue,
} from "@loom-ui/core/chat-ui";
import { type PropertyValues, type TemplateResult, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { say } from "../say";
import { LuWidget } from "./base";
import { type DispatchResult, dispatch, failureText, inputStyles } from "./chatShared";
import type { MediaHostOptions } from "./lu-media";
import { type VirtualizeOptions, resolveVirtualize } from "./virtual";

// ── Chat (U8): a transcript ──────────────────────────────────────────────────────────────────────
//
// Bound to a `ChatValue` (the contract `checkKindValue` enforces before this draws anything).
//
// EVERYTHING IN A TURN IS UNTRUSTED TEXT and is drawn as a Lit text binding — never `unsafeHTML`,
// never a markdown pass, never an auto-link. The value may come from a source that did not sanitise
// (a hydrated provider rather than `ChatFeed`), so text is cleaned again here (`sanitizeChatText`:
// terminal escapes, bidi overrides, TAG characters), memoised per part. A failure is a FIXED
// sentence plus a reference id; the source's error text does not exist in the value. A RESTRICTED
// entry draws a bare placeholder and nothing else, whatever it carries.
//
// LIVE REPLIES. A streaming entry keeps the id its durable successor will have, so when the reply
// is final nothing remounts and nothing shifts. The log is a polite live region held `aria-busy`
// while a reply streams, so a screen reader hears the settled reply once (as `StreamingText`).
//
// REASONING (loom ADR 0133). An assistant entry MAY carry `reasoning` (only when the host turned it on in
// `ChatFeed`); nothing is drawn for an entry without it, so an existing transcript is byte-identical. It is
// model output derived from untrusted input, so it is drawn exactly like reply text: a Lit text binding,
// cleaned again here, never markup. A collapsed-by-default disclosure (a button with `aria-expanded` that
// controls a labelled region, outside the live announcements: a reader opts in by opening it). A `summary`
// says it is a summary; `redacted` / removed / unverifiable reasoning is a marker with no text. A reply whose
// stored reasoning has not been fetched (`unloaded`) asks the host for it ONCE, when first expanded
// (LOAD_REASONING `{ cursor }`, a read), never eagerly.
//
// REFERENCE MARKERS. When the source says `refMarkers`, `[[id]]` in an assistant text part is replaced, for an id
// the entry lists in `refs`, by a button this widget builds (numbered by first appearance); any other marker is
// removed, and while the reply streams every marker is hidden. Nothing else in the text becomes markup. A press
// emits CHAT_REF_OPEN `{ entryId, refId, n }` (a read), awaits the host, and shows a refused or failed answer in a
// status line; a button whose open is in flight is `aria-disabled` (it keeps focus) and ignores further presses.
//
// EDIT. "Edit" on the viewer's own complete turn opens an inline editor and emits EDIT_TURN
// `{ turn, text, key }`. It never changes what is drawn: the host decides what an edit means
// (a new turn, a fork), and the new turn arrives as a new entry marked `editOf`.
//
// KEYBOARD / FOCUS. The log is a focusable scroll region; "Load earlier" keeps the scroll position
// (the entry you were reading stays where it was) and hands focus back to the log if its button goes
// away; the editor takes focus when it opens, Escape closes it back onto its "Edit" button, and
// Ctrl/Cmd+Enter sends.

const NEAR_BOTTOM = 48;
const textCache = new WeakMap<ChatPart, string>();
const cleanText = (part: ChatPart & { type: "text" }): string => {
  let c = textCache.get(part);
  if (c === undefined) {
    c = sanitizeChatText(part.text);
    textCache.set(part, c);
  }
  return c;
};

const reasoningCache = new WeakMap<ChatReasoning, string>();
const cleanReasoning = (r: ChatReasoning): string => {
  let c = reasoningCache.get(r);
  if (c === undefined) {
    c = sanitizeChatText(r.text);
    reasoningCache.set(r, c);
  }
  return c;
};

const TAG_OF: Readonly<Record<string, string>> = {
  Image: "lu-image",
  Audio: "lu-audio",
  Video: "lu-video",
  File: "lu-file",
};
const mediaKindOf = (mediaType: string): string =>
  (["Image", "Audio", "Video"] as const).find((k) =>
    mediaType.startsWith(mediaFamily(k) as string)
  ) ?? "File";

export class LuChat extends LuWidget {
  readonly kind = "Chat";
  static styles = [
    inputStyles,
    css`
      :host {
        height: 100%;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      section {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
      }
      .log {
        flex: 1;
        min-height: 4em;
        overflow-y: auto;
        overflow-anchor: auto;
        overscroll-behavior: contain;
      }
      .older {
        align-self: center;
        margin: 0 0 6px;
      }
      .log[data-windowed] article {
        content-visibility: auto;
        contain-intrinsic-size: auto var(--lu-entry-h, 96px);
      }
      article {
        margin: 0 0 10px;
        padding: 6px 10px;
        border: 1px solid var(--lu-border, #30363d);
        border-radius: var(--lu-radius, 4px);
        max-width: 100%;
      }
      article[data-role="user"] {
        background: var(--lu-panel, transparent);
      }
      article[data-own] {
        margin-inline-start: 12%;
      }
      article[data-role="assistant"] {
        margin-inline-end: 12%;
      }
      article[data-status="restricted"] {
        border-style: dashed;
        color: var(--lu-text-dim, #8b949e);
      }
      article[data-status="failed"],
      article[data-status="rejected"] {
        border-color: var(--lu-status-critical, #f87171);
      }
      article[data-status="interrupted"] {
        border-color: var(--lu-status-warning, #fbbf24);
      }
      header {
        display: flex;
        gap: 6px;
        align-items: baseline;
        font-size: 12px;
        color: var(--lu-text-dim, #8b949e);
      }
      .who {
        font-weight: 700;
      }
      .text {
        margin: 4px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .fixed {
        margin: 4px 0 0;
        font-size: 12px;
        font-style: italic;
      }
      .tools {
        margin: 4px 0 0;
        padding: 0;
        list-style: none;
        font-size: 11px;
        color: var(--lu-text-dim, #8b949e);
      }
      .reasoning {
        margin: 4px 0 0;
        font-size: 12px;
        color: var(--lu-text-dim, #8b949e);
      }
      .reasoning button {
        font-size: 12px;
        padding: 2px 6px;
        color: inherit;
        background: transparent;
        border: 1px solid var(--lu-border, #30363d);
        border-radius: var(--lu-radius, 4px);
        cursor: pointer;
      }
      .reasoning .body {
        margin: 4px 0 0;
        padding: 4px 8px;
        border-inline-start: 2px solid var(--lu-border, #30363d);
      }
      .reasoning .body p {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-style: italic;
      }
      .reasoning .body p + p {
        margin-top: 4px;
      }
      button.ref {
        all: unset;
        position: relative;
        cursor: pointer;
        display: inline-block;
        min-width: 1.4em;
        margin: 0 1px;
        padding: 0 4px;
        text-align: center;
        font-size: 0.8em;
        line-height: 1.5;
        vertical-align: super;
        border-radius: var(--lu-radius, 6px);
        background: var(--lu-panel-2, rgba(99, 102, 241, 0.16));
        color: var(--lu-accent, #6366f1);
      }
      /* A 24 x 24 px hit area (WCAG 2.2 2.5.8) around the small superscript, without changing its size. */
      button.ref::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        min-width: 24px;
        min-height: 24px;
        width: 100%;
        height: 100%;
        transform: translate(-50%, -50%);
      }
      button.ref:hover {
        background: var(--lu-accent, #6366f1);
        color: var(--lu-bg, #fff);
      }
      button.ref[aria-disabled="true"] {
        cursor: progress;
        color: var(--lu-text-dim, #8b949e);
      }
      button.ref:focus-visible {
        outline: 2px solid var(--lu-accent, #6366f1);
        outline-offset: 1px;
      }
      .ref-status {
        margin: 0 0 6px;
        font-size: 12px;
        color: var(--lu-status-critical, #f87171);
      }
      .caret {
        display: inline-block;
        width: 0.5em;
        height: 1em;
        vertical-align: text-bottom;
        margin-inline-start: 1px;
        background: var(--lu-text-dim, #8b949e);
      }
      .editor textarea {
        margin-top: 4px;
      }
      .editor .actions {
        display: flex;
        gap: 6px;
      }
      .typing {
        min-height: 1.4em;
        margin: 0;
        font-size: 12px;
        color: var(--lu-text-dim, #8b949e);
      }
      .empty,
      .closed {
        margin: 0 0 6px;
        font-size: 12px;
        font-style: italic;
        color: var(--lu-text-dim, #8b949e);
      }
      @media (prefers-reduced-motion: no-preference) {
        .caret {
          animation: lu-blink 1s steps(2, start) infinite;
        }
      }
      @keyframes lu-blink {
        to {
          visibility: hidden;
        }
      }
    `,
  ];

  /** Host seams for media parts (the same options the media widgets take). */
  @property({ attribute: false }) media?: MediaHostOptions;
  /**
   * U17: long transcripts. Entries are variable height (markdown-free text, media, tool lines), so the
   * window is the BROWSER'S: past `minRows` entries each article is `content-visibility: auto` with an
   * intrinsic size estimate, so off-screen turns are not laid out or painted, while the DOM, the scroll
   * geometry, "stick to the bottom" and the "load earlier" anchor all keep working unchanged. Off by default.
   */
  @property({ attribute: false }) virtualize?: boolean | VirtualizeOptions;
  @state() private editing: { turn: number; key: string } | undefined;
  @state() private draft = "";
  @state() private editPhase: "idle" | "sending" | "invalid" | DispatchResult = "idle";
  @state() private loadingOlder = false;
  /** Reference openings in flight (`entryId` + `refId`): their buttons are inert until the host answers. */
  private openingRefs = new Set<string>();
  /** The last refused or failed reference opening, in the widget's own fixed words; cleared by the next one. */
  @state() private refFailure: DispatchResult | null = null;
  /** Reply ids whose reasoning the reader has expanded. Collapsed is the default. */
  @state() private openReasoning: ReadonlySet<string> = new Set();
  /** Cursors whose stored reasoning this widget already asked for (once each; the feed reports the result). */
  private askedReasoning = new Set<string>();
  /** The cursor the in-flight "load earlier" asked for: it ends when the value stops offering that cursor. */
  private loadingCursor: string | undefined;
  private stick = true;
  private anchor: { height: number; top: number; first: string | undefined } | undefined;

  private get chat(): ChatValue | undefined {
    return this.state().state === "ready" ||
      this.state().state === "pending" ||
      this.state().state === "stale"
      ? (this.value as ChatValue | undefined)
      : undefined;
  }
  private get editable(): boolean {
    return (this.widget.props as { editable?: unknown }).editable === true;
  }
  private get log(): HTMLElement | null {
    return this.shadowRoot?.querySelector<HTMLElement>(".log") ?? null;
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (!changed.has("value")) return;
    const log = this.log;
    if (log !== null)
      this.stick = log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM;
    // The load landed (the value no longer offers the cursor it asked for). A live delta in the
    // meantime changes the value too and must NOT re-enable the button.
    if (this.loadingOlder && this.chat?.older !== this.loadingCursor) this.loadingOlder = false;
    // An entry the editor was open on that is gone, or no longer the viewer's own, closes it.
    const v = this.chat;
    if (this.editing !== undefined && v !== undefined) {
      const e = v.entries.find((x) => x.turn === this.editing?.turn && x.role === "user");
      if (e === undefined || e.status !== "complete") this.editing = undefined;
    }
  }

  protected override updated(changed: PropertyValues): void {
    const log = this.log;
    if (log === null || !changed.has("value")) return;
    const a = this.anchor;
    this.anchor = undefined;
    const first = this.chat?.entries[0]?.id;
    if (a !== undefined && first !== a.first) {
      // Earlier turns were added above: keep the turn the reader was on exactly where it was.
      log.scrollTop = a.top + (log.scrollHeight - a.height);
    } else if (this.stick) log.scrollTop = log.scrollHeight;
    // The "load earlier" button is gone (the start is in the window): do not strand focus.
    if (a !== undefined && this.chat?.older === undefined) log.focus({ preventScroll: true });
  }

  private loadOlder = async (): Promise<void> => {
    const v = this.chat;
    const log = this.log;
    if (v?.older === undefined || this.loadingOlder) return;
    this.loadingOlder = true;
    this.loadingCursor = v.older;
    if (log !== null)
      this.anchor = { height: log.scrollHeight, top: log.scrollTop, first: v.entries[0]?.id };
    const r = await dispatch(this.onAction, {
      type: LOAD_OLDER_ACTION,
      widgetId: this.widget.id,
      payload: { cursor: v.older },
    });
    if (r !== "ok") {
      this.loadingOlder = false;
      this.anchor = undefined;
    }
  };

  // ── reference markers ────────────────────────────────────────────────────────────────────────

  /** The text part as text, with listed reference markers drawn as buttons when the source writes markers. */
  private textOf(
    e: ChatEntry,
    p: ChatPart & { type: "text" },
    v: ChatValue
  ): TemplateResult | string {
    const clean = cleanText(p);
    if (v.refMarkers !== true || e.role !== "assistant") return clean;
    const known = new Set((e.refs ?? []).map((r) => r.id));
    const segs = splitRefMarkers(clean, known, { hideAll: e.status === "streaming" });
    return html`${segs.map((s) =>
      s.type === "text"
        ? s.text
        : html`<button type="button" class="ref" data-ref=${s.id} aria-label=${say("lu.chat.ref", { n: s.n })} aria-disabled=${this.openingRefs.has(`${e.id}\u0000${s.id}`) ? "true" : "false"} @click=${() => void this.openRef(e.id, s.id, s.n)}>${s.n}</button>`
    )}`;
  }

  private async openRef(entryId: string, refId: string, n: number): Promise<void> {
    const slot = `${entryId}\u0000${refId}`;
    if (this.openingRefs.has(slot)) return;
    this.openingRefs = new Set(this.openingRefs).add(slot);
    this.refFailure = null;
    this.requestUpdate();
    const result = await dispatch(this.onAction, {
      type: CHAT_REF_OPEN_ACTION,
      widgetId: this.widget.id,
      payload: { entryId, refId, n },
    });
    const left = new Set(this.openingRefs);
    left.delete(slot);
    this.openingRefs = left;
    this.refFailure = result === "ok" ? null : result;
    this.requestUpdate();
  }

  // ── editing ──────────────────────────────────────────────────────────────────────────────────

  private startEdit(entry: ChatEntry): void {
    const text = (entry.parts ?? [])
      .filter((p): p is ChatPart & { type: "text" } => p.type === "text")
      .map(cleanText)
      .join("\n");
    this.editing = { turn: entry.turn, key: newSubmitKey() };
    this.draft = text;
    this.editPhase = "idle";
    void this.updateComplete.then(() => {
      const ta = this.shadowRoot?.querySelector<HTMLTextAreaElement>("[data-edit-field]");
      ta?.focus();
      ta?.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  private cancelEdit(returnFocusTo?: number): void {
    this.editing = undefined;
    this.editPhase = "idle";
    if (returnFocusTo !== undefined)
      void this.updateComplete.then(() =>
        this.shadowRoot
          ?.querySelector<HTMLElement>(`[data-edit-button="${returnFocusTo}"]`)
          ?.focus()
      );
  }

  private async sendEdit(): Promise<void> {
    const edit = this.editing;
    if (edit === undefined || this.editPhase === "sending") return;
    const v = validateTextValue(this.draft);
    if (!v.ok) {
      this.editPhase = "invalid";
      return;
    }
    this.editPhase = "sending";
    const r = await dispatch(this.onAction, {
      type: EDIT_TURN_ACTION,
      widgetId: this.widget.id,
      payload: { turn: edit.turn, text: v.text, key: edit.key },
    });
    if (r === "ok") {
      this.editing = undefined;
      this.editPhase = "idle";
      this.log?.focus({ preventScroll: true });
    } else this.editPhase = r;
  }

  private onEditKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.cancelEdit(this.editing?.turn);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void this.sendEdit();
    }
  };

  // ── drawing ──────────────────────────────────────────────────────────────────────────────────

  private mediaPart(
    entry: ChatEntry,
    part: ChatPart & { type: "media" },
    i: number
  ): TemplateResult {
    const kind = mediaKindOf(part.ref.mediaType);
    const tag = TAG_OF[kind] as string;
    // The media elements are the opt-in `@loom-ui/renderer-lit/media` entry. Without it the part is
    // DESCRIBED (type, name, size) and nothing is loaded; no address is ever printed.
    if (typeof customElements === "undefined" || customElements.get(tag) === undefined)
      return html`<p class="fixed" data-media-state="not-loaded">${describeMedia(kind, part.ref, say)}</p>`;
    const widget = { id: `${entry.id}.p${i}`, kind, title: "", props: {} };
    switch (kind) {
      case "Image":
        return html`<lu-image .widget=${widget} .value=${part.ref} .media=${this.media}></lu-image>`;
      case "Audio":
        return html`<lu-audio .widget=${widget} .value=${part.ref} .media=${this.media}></lu-audio>`;
      case "Video":
        return html`<lu-video .widget=${widget} .value=${part.ref} .media=${this.media}></lu-video>`;
      default:
        return html`<lu-file .widget=${widget} .value=${part.ref} .media=${this.media}></lu-file>`;
    }
  }

  private toggleReasoning(e: ChatEntry): void {
    const next = new Set(this.openReasoning);
    if (next.has(e.id)) next.delete(e.id);
    else {
      next.add(e.id);
      const r = e.reasoning;
      // First expand of a reply whose stored reasoning is not here yet: ask the host, once.
      if (
        r?.status === "unloaded" &&
        e.cursor !== undefined &&
        !this.askedReasoning.has(e.cursor)
      ) {
        this.askedReasoning.add(e.cursor);
        const cursor = e.cursor;
        void dispatch(this.onAction, {
          type: LOAD_REASONING_ACTION,
          widgetId: this.widget.id,
          payload: { cursor },
        }).then((res) => {
          // Not handled: allow a later expand to ask again.
          if (res !== "ok") this.askedReasoning.delete(cursor);
        });
      }
    }
    this.openReasoning = next;
  }

  private reasoningBody(r: ChatReasoning): TemplateResult | typeof nothing {
    switch (r.status) {
      case "erased":
        return html`<p data-reasoning-note>${say("lu.chat.reasoning.erased")}</p>`;
      case "digest-mismatch":
        return html`<p data-reasoning-note>${say("lu.chat.reasoning.unverified")}</p>`;
      case "unavailable":
        return html`<p data-reasoning-note>${say("lu.chat.reasoning.unavailable")}</p>`;
      case "unloaded":
      case "loading":
        return html`<p data-reasoning-note>${say("lu.chat.reasoning.loading")}</p>`;
      default:
    }
    if (r.kind === "redacted")
      return html`<p data-reasoning-note>${say("lu.chat.reasoning.redacted")}</p>`;
    return html`${r.kind === "summary" ? html`<p data-reasoning-note>${say("lu.chat.reasoning.summaryNote")}</p>` : nothing}<p data-reasoning-text>${cleanReasoning(r)}</p>${r.truncated === true ? html`<p data-reasoning-note>${say("lu.chat.reasoning.truncated")}</p>` : nothing}`;
  }

  private reasoning(e: ChatEntry): TemplateResult | typeof nothing {
    const r = e.reasoning;
    if (r === undefined || e.role !== "assistant") return nothing;
    const open = this.openReasoning.has(e.id);
    const label =
      r.kind === "summary" && (r.status === undefined || r.status === "ok")
        ? say("lu.chat.reasoning.summaryLabel")
        : say("lu.chat.reasoning.label");
    const state = r.streaming ? ` (${say("lu.chat.reasoning.inProgress")})` : "";
    return html`<div class="reasoning" data-reasoning data-kind=${r.kind} data-status=${r.status ?? nothing} ?data-streaming=${r.streaming}>
      <button type="button" data-reasoning-toggle id=${`rb-${e.id}`} aria-expanded=${open ? "true" : "false"} aria-controls=${`rr-${e.id}`} @click=${() => this.toggleReasoning(e)}>${label}${state}</button>
      <div class="body" id=${`rr-${e.id}`} role="region" aria-labelledby=${`rb-${e.id}`} aria-live="off" ?hidden=${!open}>${open ? this.reasoningBody(r) : nothing}</div>
    </div>`;
  }

  private entry(e: ChatEntry, v: ChatValue): TemplateResult {
    const speaker = chatSpeaker(e, v, say);
    const note = chatStatusNote(e, say);
    const own = isOwnChatEntry(e, v);
    if (e.status === "restricted") {
      // A bare placeholder: who and which turn, nothing the viewer is not cleared for.
      const by = chatActorLabel(e);
      return html`<article data-role=${e.role} data-status="restricted" data-turn=${e.turn} aria-label=${say("lu.chat.restrictedMessage")}>
        <header><span class="who">${e.role === "assistant" ? say("lu.chat.who.assistant") : by === "" ? say("lu.chat.who.user") : say("lu.chat.who.userNamed", { name: by })}</span></header>
        <p class="fixed" role="note">${say("lu.chat.restricted")}</p>
      </article>`;
    }
    const editing = this.editing?.turn === e.turn && e.role === "user";
    const canEdit =
      this.editable &&
      own &&
      e.status === "complete" &&
      v.state !== "closed" &&
      this.onAction !== undefined;
    const label = `${speaker}${note === "" ? "" : `, ${note}`}`;
    return html`<article data-role=${e.role} data-status=${e.status} data-turn=${e.turn} ?data-own=${own} ?data-edit=${e.editOf !== undefined} aria-label=${label}>
      <header>
        <span class="who">${speaker}</span>${note === "" ? nothing : html`<span class="note">(${note})</span>`}
      </header>
      ${this.reasoning(e)}
      ${
        editing
          ? this.editor()
          : html`${(e.parts ?? []).map((p, i) =>
              p.type === "text"
                ? html`<p class="text" data-text>${this.textOf(e, p, v)}${e.status === "streaming" ? html`<span class="caret" aria-hidden="true"></span>` : nothing}</p>`
                : this.mediaPart(e, p, i)
            )}`
      }
      ${
        e.status === "failed" || e.status === "rejected"
          ? html`<p class="fixed" role="note" data-fixed>${chatReasonText(e.reason, say)}${e.errorId === undefined ? nothing : html` ${say("lu.chat.line.ref", { id: e.errorId })}`}</p>`
          : nothing
      }
      ${
        e.tools !== undefined && e.tools.length > 0
          ? html`<ul class="tools">${e.tools.map((x) => html`<li>${oneLineChatText(x.name, 64)}: ${x.status}</li>`)}</ul>`
          : nothing
      }
      ${
        canEdit && !editing
          ? html`<button type="button" data-edit-button=${e.turn} @click=${() => this.startEdit(e)} aria-label=${say("lu.chat.editThis")}>${say("lu.chat.edit")}</button>`
          : nothing
      }
    </article>`;
  }

  private editor(): TemplateResult {
    const sending = this.editPhase === "sending";
    const failed =
      this.editPhase === "failed" || this.editPhase === "stale" || this.editPhase === "unavailable";
    const text = sending
      ? say("lu.chat.sending")
      : this.editPhase === "invalid"
        ? say("lu.chat.typeFirst")
        : failed
          ? failureText(this.editPhase as DispatchResult)
          : "";
    return html`<div class="editor" data-editor>
      <label for="edit-field">${say("lu.chat.editYour")}</label>
      <textarea id="edit-field" data-edit-field rows="3" .value=${this.draft} ?readonly=${sending}
        aria-describedby="edit-hint edit-status"
        @input=${(ev: Event) => {
          this.draft = (ev.target as HTMLTextAreaElement).value;
          if (this.editPhase !== "sending") this.editPhase = "idle";
        }}
        @keydown=${this.onEditKeydown}></textarea>
      <div class="hint" id="edit-hint">${say("lu.chat.editHint")}</div>
      <div class="actions">
        <button type="button" ?disabled=${sending} @click=${() => void this.sendEdit()}>${say("lu.chat.send")}</button>
        <button type="button" @click=${() => this.cancelEdit(this.editing?.turn)}>${say("lu.chat.cancel")}</button>
      </div>
      <div class="status" id="edit-status" role=${failed || this.editPhase === "invalid" ? "alert" : "status"} ?data-error=${failed || this.editPhase === "invalid"}>${text}</div>
    </div>`;
  }

  private windowed(entries: number): boolean {
    const virt = resolveVirtualize(this.virtualize);
    return virt !== undefined && entries > virt.minRows;
  }

  protected renderReady(): TemplateResult {
    const v = this.chat;
    if (v === undefined) return html`<section></section>`;
    const streaming = v.entries.some((e) => e.status === "streaming");
    const emptyText =
      typeof (this.widget.props as { emptyText?: unknown }).emptyText === "string"
        ? oneLineChatText((this.widget.props as { emptyText: string }).emptyText, 200)
        : say("lu.chat.empty");
    return html`<section aria-label=${this.title_} data-chat>
      ${
        v.older !== undefined
          ? html`<button class="older" type="button" data-older ?disabled=${this.loadingOlder} @click=${this.loadOlder}>${this.loadingOlder ? say("lu.chat.loading") : say("lu.chat.loadEarlier")}</button>`
          : nothing
      }
      <div class="log" ?data-windowed=${this.windowed(v.entries.length)} role="log" tabindex="0" aria-live="polite" aria-relevant="additions text" aria-busy=${streaming ? "true" : "false"} aria-label=${this.title_}>
        ${v.entries.length === 0 ? html`<p class="empty">${emptyText}</p>` : nothing}
        ${repeat(
          v.entries,
          (e) => e.id,
          (e) => this.entry(e, v)
        )}
      </div>
      <p class="ref-status" role="status" data-ref-status ?data-error=${this.refFailure !== null}>${this.refFailure === null ? "" : failureText(this.refFailure)}</p>
      <p class="typing" role="status">${v.running === true && !streaming && v.state !== "closed" ? say("lu.chat.replying") : ""}</p>
      ${v.state === "closed" ? html`<p class="closed" role="note">${say("lu.chat.closed")}</p>` : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-chat": LuChat;
  }
}
