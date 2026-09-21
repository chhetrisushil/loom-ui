import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { currentLocale, localeLabel, localized, setLocale, t } from "../i18n";

/**
 * Language picker. Shared by the studio and the authoring shell, so both read the
 * same list from the same place.
 *
 * Unlike genUI's `gx-locale-picker`, the list of offered locales is a plain
 * `locales` property (default `["en-US"]`) rather than fetched from a server
 * `/locales` manifest: catalog loading is app infrastructure and stays in genUI.
 *
 * Always rendered, including when only one language exists. Hiding it then looked
 * tidier but read as a missing feature — there was nothing on screen to say the app
 * HAS languages, or which one you are in. A disabled control showing "English"
 * answers both, and the header no longer changes shape when a locale file lands.
 */
@customElement("lu-locale-picker")
export class LuLocalePicker extends LitElement {
  @property({ attribute: false }) locales: string[] = ["en-US"];

  static styles = css`
    select {
      background: var(--gx-panel-2);
      color: var(--gx-text);
      border: 1px solid var(--gx-border);
      border-radius: 8px;
      padding: 6px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    select:disabled {
      /* Legible, not invisible: it is still telling you which language you are in. */
      opacity: 0.65;
      cursor: default;
    }
  `;

  constructor() {
    super();
    localized(this);
  }

  render() {
    const active = currentLocale();
    // If the active locale is one `locales` does not list — e.g. a stale saved
    // preference — the active tag is still offered, so the control always has a
    // selected option and never renders blank.
    const locales = this.locales.includes(active) ? this.locales : [active, ...this.locales];
    const soleOption = locales.length < 2;
    return html`
      <select
        aria-label=${t("Language")}
        ?disabled=${soleOption}
        title=${soleOption ? t("No other languages are available yet") : t("Language")}
        @change=${(e: Event) => setLocale((e.target as HTMLSelectElement).value)}
      >
        ${locales.map(
          (tag) =>
            // Each option is labelled in its own language — someone who needs the
            // German option cannot necessarily read the word "German".
            html`<option value=${tag} ?selected=${tag === active}>${localeLabel(tag)}</option>`
        )}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-locale-picker": LuLocalePicker;
  }
}
