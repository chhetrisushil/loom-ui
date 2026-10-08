import {
  type ChatEntry,
  type ChatPart,
  type ChatValue,
  EDIT_TURN_ACTION,
  LOAD_OLDER_ACTION,
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
  validateTextValue,
} from "@loom-ui/core/chat-ui";
import { type PropertyValues, type TemplateResult, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n";
import { LuWidget } from "./base";
import { type DispatchResult, dispatch, failureText, inputStyles } from "./chatShared";
import type { MediaHostOptions } from "./lu-media";

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

@customElement("lu-chat")
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
  @state() private editing: { turn: number; key: string } | undefined;
  @state() private draft = "";
  @state() private editPhase: "idle" | "sending" | "invalid" | DispatchResult = "idle";
  @state() private loadingOlder = false;
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
    // New data while "load earlier" was in flight: the load landed (or changed nothing).
    this.loadingOlder = false;
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
      return html`<p class="fixed" data-media-state="not-loaded">${describeMedia(kind, part.ref)}</p>`;
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

  private entry(e: ChatEntry, v: ChatValue): TemplateResult {
    const speaker = chatSpeaker(e, v.viewer);
    const note = chatStatusNote(e);
    const own = isOwnChatEntry(e, v.viewer);
    if (e.status === "restricted") {
      // A bare placeholder: who and which turn, nothing the viewer is not cleared for.
      const by = chatActorLabel(e);
      return html`<article data-role=${e.role} data-status="restricted" data-turn=${e.turn} aria-label=${t("Restricted message")}>
        <header><span class="who">${e.role === "assistant" ? t("Assistant") : by === "" ? t("User") : by}</span></header>
        <p class="fixed" role="note">${t("Restricted")}</p>
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
      ${
        editing
          ? this.editor()
          : html`${(e.parts ?? []).map((p, i) =>
              p.type === "text"
                ? html`<p class="text" data-text>${cleanText(p)}${e.status === "streaming" ? html`<span class="caret" aria-hidden="true"></span>` : nothing}</p>`
                : this.mediaPart(e, p, i)
            )}`
      }
      ${
        e.status === "failed" || e.status === "rejected"
          ? html`<p class="fixed" role="note" data-fixed>${chatReasonText(e.reason)}${e.errorId === undefined ? nothing : html` (${t("ref")} ${e.errorId})`}</p>`
          : nothing
      }
      ${
        e.tools !== undefined && e.tools.length > 0
          ? html`<ul class="tools">${e.tools.map((x) => html`<li>${oneLineChatText(x.name, 64)}: ${x.status}</li>`)}</ul>`
          : nothing
      }
      ${
        canEdit && !editing
          ? html`<button type="button" data-edit-button=${e.turn} @click=${() => this.startEdit(e)} aria-label=${t("Edit this message")}>${t("Edit")}</button>`
          : nothing
      }
    </article>`;
  }

  private editor(): TemplateResult {
    const sending = this.editPhase === "sending";
    const failed =
      this.editPhase === "failed" || this.editPhase === "stale" || this.editPhase === "unavailable";
    const text = sending
      ? t("Sending…")
      : this.editPhase === "invalid"
        ? t("Type a message first.")
        : failed
          ? failureText(this.editPhase as DispatchResult)
          : "";
    return html`<div class="editor" data-editor>
      <label for="edit-field">${t("Edit your message")}</label>
      <textarea id="edit-field" data-edit-field rows="3" .value=${this.draft} ?readonly=${sending}
        aria-describedby="edit-hint edit-status"
        @input=${(ev: Event) => {
          this.draft = (ev.target as HTMLTextAreaElement).value;
          if (this.editPhase !== "sending") this.editPhase = "idle";
        }}
        @keydown=${this.onEditKeydown}></textarea>
      <div class="hint" id="edit-hint">${t("Sent as a new message. Ctrl+Enter sends, Escape cancels.")}</div>
      <div class="actions">
        <button type="button" ?disabled=${sending} @click=${() => void this.sendEdit()}>${t("Send")}</button>
        <button type="button" @click=${() => this.cancelEdit(this.editing?.turn)}>${t("Cancel")}</button>
      </div>
      <div class="status" id="edit-status" role=${failed || this.editPhase === "invalid" ? "alert" : "status"} ?data-error=${failed || this.editPhase === "invalid"}>${text}</div>
    </div>`;
  }

  protected renderReady(): TemplateResult {
    const v = this.chat;
    if (v === undefined) return html`<section></section>`;
    const streaming = v.entries.some((e) => e.status === "streaming");
    const emptyText =
      typeof (this.widget.props as { emptyText?: unknown }).emptyText === "string"
        ? oneLineChatText((this.widget.props as { emptyText: string }).emptyText, 200)
        : t("No messages yet.");
    return html`<section aria-label=${this.title_} data-chat>
      ${
        v.older !== undefined
          ? html`<button class="older" type="button" data-older ?disabled=${this.loadingOlder} @click=${this.loadOlder}>${this.loadingOlder ? t("Loading…") : t("Load earlier messages")}</button>`
          : nothing
      }
      <div class="log" role="log" tabindex="0" aria-live="polite" aria-relevant="additions text" aria-busy=${streaming ? "true" : "false"} aria-label=${this.title_}>
        ${v.entries.length === 0 ? html`<p class="empty">${emptyText}</p>` : nothing}
        ${repeat(
          v.entries,
          (e) => e.id,
          (e) => this.entry(e, v)
        )}
      </div>
      <p class="typing" role="status">${v.running === true && !streaming && v.state !== "closed" ? t("The assistant is replying…") : ""}</p>
      ${v.state === "closed" ? html`<p class="closed" role="note">${t("This conversation is closed.")}</p>` : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-chat": LuChat;
  }
}
