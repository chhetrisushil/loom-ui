// ── The fixed words (U14) ─────────────────────────────────────────────────────────────────────────
//
// Every fixed, user-visible English string a loom-ui renderer prints (an empty state, an aria-label,
// a placeholder, a button, a status line, a terminal marker) lives HERE, once, under a stable
// namespaced key. A renderer asks for `lu.empty.noData`, never for "No data", so:
//
//  - a host sees EVERY key it may translate ({@link LU_MESSAGE_KEYS}, typed {@link LuMessageKey});
//  - the English text is the DEFAULT, so with no host override the output is byte-identical;
//  - both renderers (the DOM one and the terminal one) read the same catalogue, so they cannot drift.
//
// A string may carry `{name}` placeholders; the renderer fills them ({@link fill}). A counted noun is
// a pair of keys, `<base>.one` / `<base>.other` (a host may add the locale's other categories:
// `<base>.few`, ...), chosen by {@link selectPlural}.
//
// Text that is DATA is not here and is never translated by this layer: a title, a label, a headline,
// a cell, a chat message are the experience's own words.

export const LU_MESSAGES = {
  // ── empty / loading / error / stale (spoken summaries) ────────────────────────────────────────
  "lu.empty.noData": "No data",
  "lu.state.loading": "loading",
  "lu.state.error": "error",
  "lu.state.stale": "stale",
  "lu.state.emptyView": "empty view",
  "lu.state.noComponentCode": "no component code",
  "lu.state.unknownComponent": "unknown component: {name}",
  "lu.state.noValue": "— no value",
  "lu.state.sourceShownAs": "{type}, shown as {kind}",
  "lu.dom.noRenderer": "[No renderer for {kind}]",
  "lu.dom.rendererError": "[Renderer error for {kind}]",
  "lu.dom.rendererErrorDetail": "[Renderer error for {kind}: {detail}]",
  "lu.dom.projectionMissing": '[Projection "{id}" is not registered]',
  "lu.approval.approve": "Approve",
  "lu.approval.reject": "Reject",
  "lu.approval.none": "No pending approval",

  // ── spoken chart / table / KPI summaries ──────────────────────────────────────────────────────
  "lu.a11y.lineChart": "line chart",
  "lu.a11y.barChart": "bar chart",
  "lu.a11y.tableWith": "table with {rows} {noun}",
  "lu.a11y.unchanged": "unchanged",
  "lu.a11y.up": "up",
  "lu.a11y.down": "down",
  "lu.a11y.rightAxis": "R",

  // ── counted nouns ─────────────────────────────────────────────────────────────────────────────
  "lu.plural.row.one": "row",
  "lu.plural.row.other": "rows",
  "lu.plural.entry.one": "entry",
  "lu.plural.entry.other": "entries",

  // ── status levels (a StatusCard's level word) ─────────────────────────────────────────────────
  "lu.level.ok": "ok",
  "lu.level.warning": "warning",
  "lu.level.critical": "critical",

  // ── tables ────────────────────────────────────────────────────────────────────────────────────
  "lu.table.showing": "Showing {shown} of {total} {noun}",
  "lu.table.showMore": "Show {n} more",
  "lu.table.actions": "Actions",
  "lu.table.rowAction": "{label}: {row}",
  "lu.terminal.table.moreRows": "… {n} more {noun}",

  // ── containers (tabs / stepper) ───────────────────────────────────────────────────────────────
  "lu.container.tab": "Tab",
  "lu.container.step": "Step",
  "lu.container.steps": "Steps",
  "lu.container.back": "Back",
  "lu.container.next": "Next",
  "lu.container.stepOf": "Step {current} / {total}: {label}",

  // ── locale picker / time range ────────────────────────────────────────────────────────────────
  "lu.locale.language": "Language",
  "lu.locale.noOthers": "No other languages are available yet",
  "lu.range.title": "Time range",
  "lu.range.24h": "24h",
  "lu.range.7d": "7d",
  "lu.range.30d": "30d",
  "lu.range.90d": "90d",
  "lu.range.12m": "12m",
  "lu.range.custom": "Custom",
  "lu.range.from": "From",
  "lu.range.to": "To",

  // ── media ─────────────────────────────────────────────────────────────────────────────────────
  "lu.media.kind.image": "image",
  "lu.media.kind.audio": "audio",
  "lu.media.kind.video": "video",
  "lu.media.kind.file": "file",
  "lu.media.notLoaded": "Media renderer not loaded",
  "lu.media.untrusted": "untrusted content",
  "lu.media.tooLarge": "Media too large to display",
  "lu.media.blocked": "Untrusted media blocked",
  "lu.media.unavailable": "Media unavailable",
  "lu.media.loading": "Loading media",
  "lu.media.upload.uploading": "Uploading…",
  "lu.media.upload.attached": "Attached",
  "lu.media.upload.notAccepted": "That file type is not accepted",
  "lu.media.upload.tooLarge": "That file is too large",
  "lu.media.upload.failed": "Upload failed",
  "lu.media.upload.unavailable": "Uploads are not available",
  "lu.media.upload.stale": "The view changed; choose the file again",
  "lu.media.upload.attach": "Attach a file",

  // ── chat: surface ─────────────────────────────────────────────────────────────────────────────
  "lu.chat.notLoaded": "Chat renderer not loaded",
  "lu.chat.empty": "No messages yet.",
  "lu.chat.loadEarlier": "Load earlier messages",
  "lu.chat.loading": "Loading…",
  "lu.chat.replying": "The assistant is replying…",
  "lu.chat.closed": "This conversation is closed.",
  "lu.chat.restrictedMessage": "Restricted message",
  "lu.chat.restricted": "Restricted",
  "lu.chat.edit": "Edit",
  "lu.chat.editThis": "Edit this message",
  "lu.chat.editYour": "Edit your message",
  "lu.chat.editHint": "Sent as a new message. Ctrl+Enter sends, Escape cancels.",
  "lu.chat.send": "Send",
  "lu.chat.cancel": "Cancel",
  "lu.chat.sending": "Sending…",
  "lu.chat.typeFirst": "Type a message first.",

  // ── chat: speakers, status notes, reasons (shared with the terminal) ──────────────────────────
  "lu.chat.who.assistant": "Assistant",
  "lu.chat.who.notice": "Notice",
  "lu.chat.who.you": "You",
  "lu.chat.who.user": "User",
  "lu.chat.who.userNamed": 'User "{name}"',
  "lu.chat.status.replying": "replying",
  "lu.chat.status.interrupted": "interrupted",
  "lu.chat.status.failed": "failed",
  "lu.chat.status.rejected": "not accepted",
  "lu.chat.status.editOf": "edit of turn {turn}",
  "lu.chat.line.restricted": "[restricted {role} turn]",
  "lu.chat.line.restrictedFrom": "[restricted {role} turn from {by}]",
  "lu.chat.ref": "Source {n}",
  "lu.chat.table": "Table {n}",
  "lu.chat.code": "Code",
  "lu.chat.cut": "(reply cut short)",
  "lu.chat.newTab": "(opens in a new tab)",
  "lu.chat.line.ref": "(ref {id})",
  "lu.chat.line.tools": "[tools: {tools}]",
  "lu.chat.reason.model-error": "The assistant ran into a problem.",
  "lu.chat.reason.rate-limited": "The assistant is busy right now. Try again in a moment.",
  "lu.chat.reason.quota": "The assistant's usage limit has been reached.",
  "lu.chat.reason.tool-error": "A tool the assistant used failed.",
  "lu.chat.reason.denied": "That was not permitted.",
  "lu.chat.reason.turn-failed": "The turn could not be completed.",
  "lu.chat.reason.cancelled": "The turn was cancelled.",
  "lu.chat.reason.too-long": "The message was too long.",
  "lu.chat.reason.prompt-too-large": "The message was too large to answer.",
  "lu.chat.reason.malformed": "The message was not understood.",
  "lu.chat.reason.unauthenticated": "The message could not be verified.",
  "lu.chat.reason.replayed": "The message was already received.",
  "lu.chat.reason.stale": "The message arrived too late.",
  "lu.chat.reason.not-a-participant": "You are not a participant in this conversation.",
  "lu.chat.reason.edit-invalid": "That edit could not be applied to the earlier message.",
  "lu.chat.reason.generic": "The message was not processed.",
  "lu.chat.reasoning.label": "Reasoning",
  "lu.chat.reasoning.summaryLabel": "Reasoning summary",
  "lu.chat.reasoning.summaryNote": "A summary of the model's reasoning, not the full reasoning.",
  "lu.chat.reasoning.inProgress": "in progress",
  "lu.chat.reasoning.redacted": "The model's reasoning is redacted.",
  "lu.chat.reasoning.erased": "Reasoning removed.",
  "lu.chat.reasoning.unverified": "The stored reasoning could not be verified and is not shown.",
  "lu.chat.reasoning.unavailable": "No reasoning is available for this reply.",
  "lu.chat.reasoning.loading": "Loading reasoning…",
  "lu.chat.reasoning.truncated": "Shortened: only part of the reasoning is shown.",
  "lu.chat.line.reasoning": "[reasoning: {text}]",
  "lu.chat.line.reasoningSummary": "[reasoning summary: {text}]",
  "lu.chat.line.reasoningRedacted": "[reasoning redacted]",
  "lu.chat.line.reasoningErased": "[reasoning removed]",
  "lu.chat.dispatch.stale": "The view changed. Review it and send again.",
  "lu.chat.dispatch.unavailable": "Sending is not available here.",
  "lu.chat.dispatch.failed": "Not sent. Try again.",

  // ── inputs and forms ──────────────────────────────────────────────────────────────────────────
  "lu.input.message": "Message",
  "lu.input.hint": "Press Ctrl+Enter to send.",
  "lu.input.sent": "Sent",
  "lu.input.tooLong": "That message is too long.",
  "lu.input.form": "Form",
  "lu.input.submit": "Submit",
  "lu.input.choose": "Choose",
  "lu.input.chooseEllipsis": "Choose…",
  "lu.input.none": "None",
  "lu.input.add": "Add…",
  "lu.input.remove": "Remove",
  "lu.input.noMatches": "No matches",
  "lu.input.search": "Search",
  "lu.input.fixFields": "Fix the marked fields.",
  "lu.input.formUnavailable": "This form is not available.",
  "lu.input.choiceUnavailable": "This choice is not available.",
  "lu.input.error.required": "This field is required.",
  "lu.input.error.tooLong": "This is too long.",
  "lu.input.error.range": "This is out of range.",
  "lu.input.error.option": "Choose one of the options.",
  "lu.input.error.unknownField": "This field is not part of the form.",
  "lu.input.error.invalid": "This is not valid.",

  // ── terminal-only markers ─────────────────────────────────────────────────────────────────────
  "lu.terminal.a2ui": "[A2UI view — rendered on the web]",
  "lu.terminal.sandbox": "[sandboxed component — rendered on the web]",
  "lu.terminal.fileUpload": "[file upload — available on the web]",
  "lu.terminal.untrusted": "[untrusted]",
  "lu.terminal.media.tooLarge": "too large to open",
  "lu.terminal.media.blocked": "blocked (active content type)",
  "lu.terminal.chat.earlier": "… earlier messages are available",
  "lu.terminal.chat.empty": "(no messages)",
  "lu.terminal.chat.replying": "(the assistant is replying…)",
  "lu.terminal.chat.closed": "(conversation closed)",
  "lu.terminal.multiline": " (multi-line)",
  "lu.terminal.textInput": "[text input — answer on an interactive surface]",
  "lu.terminal.formInput": "[form — answer on an interactive surface]",
  "lu.terminal.current": "(current)",
  "lu.terminal.selectInput": "[choice — answer on an interactive surface]",
  "lu.terminal.multiSelectInput": "[choices — answer on an interactive surface]",
  "lu.terminal.moreOptions": "more options",
} as const;

/** A key a host may translate. */
export type LuMessageKey = keyof typeof LU_MESSAGES;

/**
 * Every key, sorted: what a host reads to see what it may translate. Plural bases appear as their
 * `.one` / `.other` keys; a locale with more categories adds `<base>.few` etc. (not listed here).
 */
export const LU_MESSAGE_KEYS: readonly LuMessageKey[] = /* @__PURE__ */ Object.freeze(
  (Object.keys(LU_MESSAGES) as LuMessageKey[]).sort()
);

/** Values a message's `{placeholders}` are filled with. */
export type LuMessageVars = Readonly<Record<string, string | number>>;

/**
 * The host override. All fields optional; with none, English.
 *  - `locale`: the BCP-47 tag numbers, dates and plural categories are formatted with.
 *  - `messages`: translated text per key (a catalogue). Keys it lacks fall back to `translate`, then English.
 *  - `translate`: a function form — `(key, english)` returns the text, or `undefined` to leave English.
 *    A message-format library plugs in here. A plural key is `<base>.<category>`.
 */
export interface LuI18n {
  readonly locale?: string;
  readonly messages?: Readonly<Partial<Record<string, string>>>;
  readonly translate?: (key: string, english: string) => string | undefined;
}

/** Ask for a message by key; `{placeholders}` are filled from `vars`. */
export type Say = (key: LuMessageKey, vars?: LuMessageVars) => string;

/** `{name}` placeholders replaced from `vars` (a missing one is left as written). Single pass, no recursion on the values. */
export function fill(template: string, vars?: LuMessageVars): string {
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole
  );
}

/** Look a key up in a host override, then fall back to `english`. Never throws: a throwing `translate` is English. */
export function lookupMessage(i18n: LuI18n | undefined, key: string, english: string): string {
  if (i18n === undefined) return english;
  const own =
    i18n.messages !== undefined && Object.hasOwn(i18n.messages, key)
      ? i18n.messages[key]
      : undefined;
  // An empty or whitespace-only entry is "unset", not a translation: it would blank an aria-label or a button.
  if (typeof own === "string" && own.trim() !== "") return own;
  if (i18n.translate !== undefined) {
    try {
      const r = i18n.translate(key, english);
      if (typeof r === "string" && r.trim() !== "") return r;
    } catch {
      // a broken host translator never breaks a render: English
    }
  }
  return english;
}

/** A {@link Say} over a host override; with `undefined`, English. */
export function createSay(i18n?: LuI18n): Say {
  return (key, vars) => fill(lookupMessage(i18n, key, LU_MESSAGES[key]), vars);
}

/** English: the default {@link Say}. */
export const sayEnglish: Say = /* @__PURE__ */ createSay();

// ── counted nouns ─────────────────────────────────────────────────────────────────────────────────
const pluralRules = /* @__PURE__ */ new Map<string, Intl.PluralRules | null>();
function rulesFor(locale: string): Intl.PluralRules | null {
  let r = pluralRules.get(locale);
  if (r === undefined) {
    try {
      r = new Intl.PluralRules(locale);
    } catch {
      r = null; // a tag Intl cannot parse: plain "other"
    }
    pluralRules.set(locale, r);
  }
  return r;
}
const EN_RULES = /* @__PURE__ */ new Intl.PluralRules("en");

/** The forms of a counted noun: `one` and `other` always, a locale's other categories optionally. */
export type PluralForms = { readonly one: string; readonly other: string } & {
  readonly [C in Exclude<Intl.LDMLPluralRule, "one" | "other">]?: string;
};

/**
 * A counted noun, grammatical in English at all times and in the host's language when it has one.
 * `lookup(`${key}.${category}`, english)` is the translator (identity-with-fallback when there is none).
 * The ACTIVE locale's plural category selects the form ONLY when the lookup returns something other
 * than the English fallback for that category; otherwise English rules choose, because pairing English
 * words with another language's grammar ("1 rows" under `ja`, "0 row" under `fr`) is worse than English.
 */
export function selectPlural(
  locale: string,
  key: string,
  n: number,
  english: PluralForms,
  lookup: (key: string, english: string) => string
): string {
  const category = rulesFor(locale)?.select(n) ?? "other";
  const fallback = english[category] ?? english.other;
  const localised = lookup(`${key}.${category}`, fallback);
  if (localised !== fallback) return localised;
  const en = EN_RULES.select(n) === "one" ? "one" : "other";
  return lookup(`${key}.${en}`, english[en]);
}

/** The English forms of a plural base in the catalogue (`lu.plural.row` → row / rows). */
export function pluralForms(base: "lu.plural.row" | "lu.plural.entry"): PluralForms {
  return { one: LU_MESSAGES[`${base}.one`], other: LU_MESSAGES[`${base}.other`] };
}
