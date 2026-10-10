import {
  MEDIA_ATTACH_ACTION,
  type MediaKind,
  type MediaPolicy,
  type MediaRef,
  type MediaResolver,
  type MediaUploadHandler,
  checkFileName,
  checkMediaUrl,
  cleanMediaText,
  describeMedia,
  formatBytes,
  isActiveMediaType,
  isMediaRef,
  isSameOriginMediaUrl,
  matchesAccept,
  maxBytesFor,
} from "@loom-ui/core/media";
import { type PropertyValues, type TemplateResult, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import { say } from "../say";
import { titleText } from "../title";
import { LuWidget } from "./base";

// ── Media widgets (U9): Image, Audio, Video, File, and the MediaInput upload control ─────────────
//
// THE CONTRACT. The bound value is a `MediaRef` (an opaque content ADDRESS plus metadata) — never
// bytes, never a URL. An address is not a locator: this file never builds a URL from one and never
// fetches one. The ONLY way an element gets a `src` is the host's `MediaResolver`, which authorises
// the current viewer and answers with a viewer-scoped URL; that URL is re-checked (`checkMediaUrl`:
// https/blob/same-origin only, no credentials, no private host) before it touches the DOM.
//
// WHEN IT RESOLVES. Only after the value arrived (so a P2 handle, which hydrates on `markVisible`,
// resolves nothing off-screen) and, where `IntersectionObserver` exists, only once the element is
// actually on screen. `loading="lazy"` / `preload="none"` back that up; nothing autoplays.
//
// WHAT A VIEWER IS TOLD. A refusal, a missing blob, a failing resolver and a load error are ONE
// fixed text ("Media unavailable"): a distinction would be an existence oracle for an address, and
// no state ever prints the address, the URL, or the resolver's reason.
//
// TRUST. Media is untrusted unless the HOST vouches (`resolution.trusted`); user-origin media never
// is. Untrusted media is drawn with a visible marker (`data-untrusted`), or not at all under
// `policy.untrusted: "block"`.

/** The page's own origin, or undefined where there is no `location` (a server, a worker without one). */
const currentOrigin = (): string | undefined =>
  typeof location === "undefined" || location.origin === "null" ? undefined : location.origin;

/** What the host hands the media widgets (the registry option `media`). */
export interface MediaHostOptions {
  readonly resolver?: MediaResolver;
  readonly policy?: MediaPolicy;
  readonly upload?: MediaUploadHandler;
}

type ResState = "idle" | "resolving" | "ready" | "unavailable" | "too-large" | "blocked";
interface Resolved {
  readonly key: string;
  readonly state: ResState;
  readonly url?: string;
  readonly trusted?: boolean;
}
const IDLE: Resolved = { key: "", state: "idle" };

const sharedStyles = css`
  :host {
    display: block;
    height: 100%;
    padding: 4px 10px;
    box-sizing: border-box;
  }
  figure {
    margin: 0;
  }
  img,
  video {
    display: block;
    max-width: 100%;
    max-height: 100%;
    border-radius: var(--lu-radius, 4px);
  }
  audio {
    width: 100%;
  }
  figcaption,
  .meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--lu-text-dim, #8b949e);
  }
  .placeholder {
    padding: 12px;
    border: 1px dashed var(--lu-border, #30363d);
    border-radius: var(--lu-radius, 4px);
    color: var(--lu-text-dim, #8b949e);
    font-size: 12px;
    font-style: italic;
  }
  .untrusted {
    display: inline-block;
    margin-bottom: 4px;
    padding: 0 6px;
    border: 1px solid var(--lu-status-warning, #fbbf24);
    border-radius: 999px;
    color: var(--lu-status-warning, #fbbf24);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  a {
    color: var(--lu-accent, #58a6ff);
    overflow-wrap: anywhere;
  }
`;

/** The shared resolve machinery. A subclass names its kind and draws the resolved element. */
abstract class LuMedia extends LuWidget {
  static styles = sharedStyles;

  /** Host seams. A widget with no resolver draws the unavailable state: nothing is ever loaded by default. */
  @property({ attribute: false }) media?: MediaHostOptions;
  @state() private resolved: Resolved = IDLE;

  protected abstract readonly purpose: "display" | "download";
  private abort: AbortController | undefined;
  private stopWatching: (() => void) | undefined;

  /** The validated ref, or undefined when the matrix is not showing a value. */
  protected get ref(): MediaRef | undefined {
    return isMediaRef(this.kind, this.value) ? (this.value as MediaRef) : undefined;
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (!changed.has("value") && !changed.has("media") && !changed.has("status")) return;
    // Only a value the matrix is actually showing resolves (an error / empty status never does).
    const shown = ["ready", "pending", "stale"].includes(this.state().state);
    const ref = shown ? this.ref : undefined;
    const key =
      ref === undefined
        ? ""
        : [ref.address, ref.mediaType, ref.size ?? "", ref.origin ?? ""].join("\u0000");
    if (key === this.resolved.key && !changed.has("media")) return;
    this.cancel();
    if (ref === undefined) {
      this.resolved = IDLE;
      return;
    }
    this.resolved = { key, state: "resolving" };
    this.whenOnScreen(() => void this.resolve(ref, key));
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancel();
  }

  private cancel(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  private whenOnScreen(run: () => void): void {
    if (typeof IntersectionObserver === "undefined") {
      run();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      this.stopWatching = undefined;
      run();
    });
    io.observe(this);
    this.stopWatching = () => io.disconnect();
  }

  private settle(key: string, next: Resolved): void {
    if (this.resolved.key === key) this.resolved = next;
  }

  private async resolve(ref: MediaRef, key: string): Promise<void> {
    const kind = this.kind as MediaKind;
    const policy = this.media?.policy;
    const limit = maxBytesFor(kind, policy);
    // An oversized DECLARED size is refused before the resolver is ever asked.
    if (ref.size !== undefined && ref.size > limit)
      return this.settle(key, { key, state: "too-large" });
    // Active content (HTML, SVG, XML, script types) from a USER is untrusted for certain: the same
    // bytes opened in a tab are a page, so it is never drawn and the resolver is not even asked.
    if (ref.origin === "user" && isActiveMediaType(ref.mediaType))
      return this.settle(key, { key, state: "blocked" });
    const resolver = this.media?.resolver;
    if (resolver === undefined) return this.settle(key, { key, state: "unavailable" });
    const ac = new AbortController();
    this.abort = ac;
    let answer: Awaited<ReturnType<MediaResolver>>;
    try {
      // A frozen COPY: host code cannot mutate the value the store holds.
      answer = await resolver(
        { ref: Object.freeze({ ...ref }), kind, widgetId: this.widget.id, purpose: this.purpose },
        { signal: ac.signal }
      );
    } catch {
      return ac.signal.aborted ? undefined : this.settle(key, { key, state: "unavailable" });
    }
    if (ac.signal.aborted || this.resolved.key !== key) return;
    if (typeof answer !== "object" || answer === null || answer.ok !== true)
      return this.settle(key, { key, state: "unavailable" });
    const url = checkMediaUrl(answer.url, policy);
    if (!url.ok) return this.settle(key, { key, state: "unavailable" });
    const observed = answer.size;
    if (typeof observed === "number" && (!Number.isFinite(observed) || observed > limit))
      return this.settle(key, { key, state: "too-large" });
    const trusted = answer.trusted === true && ref.origin !== "user";
    if (!trusted && policy?.untrusted === "block")
      return this.settle(key, { key, state: "blocked" });
    if (!trusted) {
      // Untrusted bytes must not be served from the app's own origin (a tab opened on a same-origin
      // URL would run active content with the app's cookies), and active types are never drawn.
      if (isActiveMediaType(ref.mediaType)) return this.settle(key, { key, state: "blocked" });
      if (
        isSameOriginMediaUrl(url.url, policy?.appOrigin ?? currentOrigin()) &&
        policy?.allowSameOriginUntrusted !== true
      )
        return this.settle(key, { key, state: "blocked" });
    }
    this.settle(key, { key, state: "ready", url: url.url, trusted });
  }

  /** The accessible name: the same one-line description the terminal prints, once there is a value. */
  protected override label(): string {
    const ref = this.ref;
    if (ref !== undefined && this.state().state === "ready")
      return `${this.title_}: ${describeMedia(this.kind, ref, say)}`;
    return super.label();
  }

  /** A load error from the element itself (an expired URL, a 403): the same fixed unavailable state. */
  protected failed = (): void => {
    this.resolved = { key: this.resolved.key, state: "unavailable" };
  };

  protected get alt(): string {
    const fromProps = (this.widget.props as { alt?: unknown }).alt;
    const text = cleanMediaText(typeof fromProps === "string" ? fromProps : this.ref?.alt, 1000);
    return text;
  }
  protected get caption(): string | undefined {
    const c = (this.widget.props as { caption?: unknown }).caption;
    const text = typeof c === "string" ? cleanMediaText(c, 500) : "";
    return text === "" ? undefined : text;
  }
  protected get safeName(): string {
    return cleanMediaText(this.ref?.name);
  }

  protected abstract drawResolved(ref: MediaRef, url: string): TemplateResult;

  protected renderReady(): TemplateResult | typeof nothing {
    const ref = this.ref;
    if (ref === undefined) return nothing;
    const r = this.resolved;
    switch (r.state) {
      case "ready":
        return html`<div data-media-state="ready" data-media-kind=${this.kind.toLowerCase()} ?data-untrusted=${r.trusted !== true}>
          ${r.trusted === true ? nothing : html`<span class="untrusted" role="note">${say("lu.media.untrusted")}</span>`}
          ${this.drawResolved(ref, r.url as string)}
          ${this.caption === undefined ? nothing : html`<div class="meta" data-caption>${this.caption}</div>`}
        </div>`;
      case "too-large":
        return html`<div class="placeholder" data-media-state="too-large" role="note">${say("lu.media.tooLarge")}${ref.size === undefined ? nothing : html` (${formatBytes(ref.size)})`}</div>`;
      case "blocked":
        return html`<div class="placeholder" data-media-state="blocked" role="note">${say("lu.media.blocked")}</div>`;
      case "unavailable":
        return html`<div class="placeholder" data-media-state="unavailable" role="note">${say("lu.media.unavailable")}</div>`;
      default:
        return html`<div class="placeholder" data-media-state="resolving" role="status" aria-busy="true">${say("lu.media.loading")}</div>`;
    }
  }
}

export class LuImage extends LuMedia {
  readonly kind = "Image";
  protected readonly purpose = "display" as const;
  protected drawResolved(ref: MediaRef, url: string): TemplateResult {
    // `alt` falls back to the file name, then the kind: never an empty (decorative) alt for content.
    const alt = this.alt || this.safeName || say("lu.media.kind.image");
    return html`<figure><img
      src=${url}
      alt=${alt}
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      draggable="false"
      @error=${this.failed}
    /></figure>`;
  }
}

export class LuAudio extends LuMedia {
  readonly kind = "Audio";
  protected readonly purpose = "display" as const;
  protected drawResolved(ref: MediaRef, url: string): TemplateResult {
    const label = this.alt || this.safeName || describeMedia("Audio", ref, say);
    return html`<audio controls preload="none" src=${url} aria-label=${label} @error=${this.failed}></audio>`;
  }
}

export class LuVideo extends LuMedia {
  readonly kind = "Video";
  protected readonly purpose = "display" as const;
  protected drawResolved(ref: MediaRef, url: string): TemplateResult {
    const label = this.alt || this.safeName || describeMedia("Video", ref, say);
    return html`<video controls preload="none" playsinline src=${url} aria-label=${label} @error=${this.failed}></video>`;
  }
}

export class LuFile extends LuMedia {
  readonly kind = "File";
  protected readonly purpose = "download" as const;
  protected drawResolved(ref: MediaRef, url: string): TemplateResult {
    const named = checkFileName(ref.name, ref.mediaType);
    const shown =
      ref.name === undefined || this.safeName === "" ? say("lu.media.kind.file") : named.display;
    const meta = [ref.mediaType, ref.size === undefined ? "" : formatBytes(ref.size)]
      .filter((s) => s !== "")
      .join(", ");
    return html`<a
        href=${url}
        download=${named.download}
        ?data-type-mismatch=${named.mismatch}
        rel="noopener noreferrer nofollow"
        referrerpolicy="no-referrer"
        >${shown}</a
      ><span class="meta" data-file-meta> (${meta})</span>`;
  }
}

// ── MediaInput: the upload control ───────────────────────────────────────────────────────────────
// Static (props only; a value reaching it is a contract error, as for a Note). The user picks a file;
// it goes to the HOST's `MediaUploadHandler`, which stores the bytes and returns a `MediaRef`. This
// widget stores nothing and reads no bytes. The ref it emits is validated, stamped `origin: "user"`
// (user-provided media is untrusted whatever the handler claimed) and sent as a `MEDIA_ATTACH`
// action, which the renderer stamps with `viewedVersion` like every action. The type/size checks here
// are courtesy only: the host's handler is the enforcement point.

type InputState =
  | "idle"
  | "uploading"
  | "attached"
  | "type"
  | "size"
  | "failed"
  | "unavailable"
  | "stale";

export class LuMediaInput extends LuWidget {
  readonly kind = "MediaInput";
  static styles = [
    sharedStyles,
    css`
      label {
        display: block;
        font-size: 12px;
        font-weight: 600;
        color: var(--lu-text-dim, #8b949e);
        margin-bottom: 4px;
      }
      .status {
        margin-top: 4px;
        font-size: 12px;
        color: var(--lu-text-dim, #8b949e);
      }
      .status[data-error] {
        color: var(--lu-status-critical, #f87171);
      }
    `,
  ];

  @property({ attribute: false }) media?: MediaHostOptions;
  @state() private phase: InputState = "idle";
  private abort: AbortController | undefined;

  override render(): TemplateResult | typeof nothing {
    if (!this.widget) return nothing;
    if (this.value !== undefined) return super.render();
    return this.renderReady();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.abort?.abort();
  }

  private get accept(): readonly string[] | undefined {
    const a = (this.widget.props as { accept?: unknown }).accept;
    return Array.isArray(a) && a.every((p) => typeof p === "string") ? (a as string[]) : undefined;
  }
  private get limit(): number {
    const p = (this.widget.props as { maxBytes?: unknown }).maxBytes;
    const host = maxBytesFor("File", this.media?.policy);
    return typeof p === "number" && Number.isInteger(p) && p > 0 ? Math.min(p, host) : host;
  }

  private onPick = async (ev: Event): Promise<void> => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;
    const upload = this.media?.upload;
    const candidate = {
      name: cleanMediaText(file.name),
      mediaType: String(file.type).toLowerCase(),
      size: file.size,
    };
    const reset = (): void => {
      try {
        input.value = "";
      } catch {
        /* a file input may refuse; the state is what matters */
      }
    };
    if (upload === undefined) {
      this.phase = "unavailable";
      return reset();
    }
    const accept = this.accept;
    if (accept !== undefined && !matchesAccept(candidate.mediaType, accept)) {
      this.phase = "type";
      return reset();
    }
    if (candidate.size > this.limit) {
      this.phase = "size";
      return reset();
    }
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    const started = this.widget;
    this.phase = "uploading";
    let result: Awaited<ReturnType<MediaUploadHandler>>;
    try {
      result = await upload({ candidate, body: file, widgetId: started.id }, { signal: ac.signal });
    } catch {
      if (!ac.signal.aborted) this.phase = "failed";
      return reset();
    }
    reset();
    if (ac.signal.aborted) return;
    // A recompose / removal during the upload: the view the user acted on is gone, so the action
    // would be stamped with a DIFFERENT view than the one they chose a file in. Drop it.
    if (this.widget !== started || !this.isConnected) {
      this.phase = "stale";
      return;
    }
    if (
      typeof result !== "object" ||
      result === null ||
      result.ok !== true ||
      !isMediaRef("File", result.ref)
    ) {
      this.phase = "failed";
      return;
    }
    const ref = result.ref as MediaRef;
    if (
      (accept !== undefined && !matchesAccept(ref.mediaType, accept)) ||
      (ref.size !== undefined && ref.size > this.limit)
    ) {
      this.phase = "failed";
      return;
    }
    this.phase = "attached";
    this.onAction?.({
      type: MEDIA_ATTACH_ACTION,
      widgetId: started.id,
      payload: { ref: { ...ref, origin: "user" } },
    });
  };

  private statusText(): { text: string; error: boolean } | undefined {
    switch (this.phase) {
      case "uploading":
        return { text: say("lu.media.upload.uploading"), error: false };
      case "attached":
        return { text: say("lu.media.upload.attached"), error: false };
      case "type":
        return { text: say("lu.media.upload.notAccepted"), error: true };
      case "size":
        return { text: say("lu.media.upload.tooLarge"), error: true };
      case "failed":
        return { text: say("lu.media.upload.failed"), error: true };
      case "unavailable":
        return { text: say("lu.media.upload.unavailable"), error: true };
      case "stale":
        return { text: say("lu.media.upload.stale"), error: true };
      default:
        return undefined;
    }
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const label =
      titleText((this.widget.props as { label?: unknown }).label) ??
      titleText(this.widget.title) ??
      say("lu.media.upload.attach");
    const accept = (this.accept ?? []).join(",");
    const s = this.statusText();
    return html`<div role="group" aria-label=${label} data-media-input data-phase=${this.phase}>
      <label>${label}
        <input type="file" accept=${accept === "" ? nothing : accept} ?disabled=${this.phase === "uploading"} @change=${this.onPick} />
      </label>
      <div class="status" role="status" aria-live="polite" ?data-error=${s?.error === true}>${s?.text ?? ""}</div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-image": LuImage;
    "lu-audio": LuAudio;
    "lu-video": LuVideo;
    "lu-file": LuFile;
    "lu-media-input": LuMediaInput;
  }
}
