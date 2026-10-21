import { parseChatMarkdown, resolveMdMarkers } from "./chatMarkdown";
import { chatMarkdownLines } from "./chatMdText";
import { oneLineChatText } from "./chatText";
import { type ChatEntry, type ChatValue, sameChatActor } from "./chatValue";
import { mediaFamily } from "./mediaRef";
import { describeMedia } from "./mediaText";
import { type LuMessageKey, type Say, sayEnglish } from "./messages";

// ── Words both renderers share ───────────────────────────────────────────────────────────────────

/** The reason tokens with a fixed sentence (`lu.chat.reason.<token>`); any other token gets the generic one. */
const REASONS = new Set([
  "model-error",
  "denied",
  "turn-failed",
  "cancelled",
  "too-long",
  "prompt-too-large",
  "malformed",
  "unauthenticated",
  "replayed",
  "stale",
  "not-a-participant",
  "edit-invalid",
]);

/** One fixed sentence for a failure / rejection reason; unknown tokens get the generic sentence, never their own text. */
export function chatReasonText(reason: string | undefined, say: Say = sayEnglish): string {
  return reason !== undefined && REASONS.has(reason)
    ? say(`lu.chat.reason.${reason}` as LuMessageKey)
    : say("lu.chat.reason.generic");
}

/** What a reader needs to tell whose turn a user entry is. */
export type ChatWho = Pick<ChatValue, "viewer" | "mode">;

/**
 * Is this user entry the viewer's own? With an `asker` it is when that identity equals the viewer's.
 * WITHOUT one it is only when the value is KNOWN owner-only (`mode: "owner"`): in a shared or unknown
 * conversation a turn nobody is named on is nobody's in particular, never "yours".
 */
export function isOwnChatEntry(entry: ChatEntry, who: ChatWho): boolean {
  if (entry.role !== "user") return false;
  if (entry.asker === undefined) return who.mode === "owner";
  return sameChatActor(entry.asker, who.viewer);
}

/** `alice`, from an actor; never the tenant. Untrusted text, cleaned and bounded; quotes cannot close the quoting around it. */
export function chatActorLabel(entry: ChatEntry): string {
  const a = entry.asker?.actor;
  return a === undefined ? "" : oneLineChatText(a, 60).replace(/"/g, "'");
}

/**
 * Who is speaking, in words: `You`, `User "alice"`, `User`, `Assistant`, `Notice`. A PERSON is always
 * introduced by the word `User` and their name in quotes, so a name cannot pass itself off as a role
 * (`Assistant`, `Notice`, `You`): the role words are reserved to the roles.
 */
export function chatSpeaker(entry: ChatEntry, who: ChatWho, say: Say = sayEnglish): string {
  if (entry.role === "assistant") return say("lu.chat.who.assistant");
  if (entry.role === "system") return say("lu.chat.who.notice");
  if (isOwnChatEntry(entry, who)) return say("lu.chat.who.you");
  const name = chatActorLabel(entry);
  return name === "" ? say("lu.chat.who.user") : say("lu.chat.who.userNamed", { name });
}

/** The status note, in words (`interrupted`, `replying`, ...), or `""` for a plain complete entry. */
export function chatStatusNote(entry: ChatEntry, say: Say = sayEnglish): string {
  const parts: string[] = [];
  if (entry.status === "streaming") parts.push(say("lu.chat.status.replying"));
  else if (entry.status === "interrupted") parts.push(say("lu.chat.status.interrupted"));
  else if (entry.status === "failed") parts.push(say("lu.chat.status.failed"));
  else if (entry.status === "rejected") parts.push(say("lu.chat.status.rejected"));
  if (entry.editOf !== undefined) parts.push(say("lu.chat.status.editOf", { turn: entry.editOf }));
  return parts.join(", ");
}

const kindOfType = (mediaType: string): string =>
  (["Image", "Audio", "Video"] as const).find((k) =>
    mediaType.startsWith(mediaFamily(k) as string)
  ) ?? "File";

/**
 * One line for a reply's reasoning, or `""` when there is nothing to say (none, or not fetched yet). A
 * summary is labelled as one; redacted and removed reasoning are markers with no text. Untrusted model
 * output: cleaned and bounded like any turn.
 */
export function chatReasoningLine(entry: ChatEntry, maxText = 2000, say: Say = sayEnglish): string {
  const r = entry.reasoning;
  if (r === undefined) return "";
  if (r.status === "erased") return say("lu.chat.line.reasoningErased");
  if (r.status !== undefined && r.status !== "ok") return "";
  if (r.kind === "redacted") return say("lu.chat.line.reasoningRedacted");
  const text = oneLineChatText(r.text, maxText);
  if (text === "") return "";
  return say(r.kind === "summary" ? "lu.chat.line.reasoningSummary" : "lu.chat.line.reasoning", {
    text,
  });
}

/**
 * A markdown reply as plain lines (one string, newline-joined): markers numbered when listed, hidden while the reply
 * streams. The whole part is capped at 4 x `maxText` characters (markup and link addresses take room a plain text does
 * not), then `…`: a part's size is bounded as a plain part's is, by the caller's `maxText`.
 */
function markdownBody(e: ChatEntry, text: string, value: ChatValue, maxChars: number): string {
  const markers = value.refMarkers === true;
  const streaming = e.status === "streaming";
  const doc = parseChatMarkdown(text, { markers, streaming });
  const shown = markers
    ? resolveMdMarkers(doc, new Set((e.refs ?? []).map((r) => r.id)), { hideAll: streaming })
    : doc;
  return chatMarkdownLines(shown, { maxChars }).join("\n");
}

/**
 * A transcript as plain lines — what the terminal prints and what a screen reader's summary says.
 * Every text is cleaned and bounded; a restricted entry is a bare placeholder; a failure is the
 * fixed sentence plus its reference id. No address, URL or timestamp appears.
 */
export function chatTranscriptLines(
  value: ChatValue,
  options: { maxText?: number; say?: Say } = {}
): string[] {
  const maxText = options.maxText ?? 2000;
  const say = options.say ?? sayEnglish;
  const lines: string[] = [];
  for (const e of value.entries) {
    if (e.status === "restricted") {
      const by = chatActorLabel(e);
      lines.push(
        by === ""
          ? say("lu.chat.line.restricted", { role: e.role })
          : say("lu.chat.line.restrictedFrom", { role: e.role, by })
      );
      continue;
    }
    const note = chatStatusNote(e, say);
    const head = `${chatSpeaker(e, value, say)}${note === "" ? "" : ` (${note})`}`;
    const body: string[] = [];
    const multi = new Set<number>(); // body items that are markdown (several lines): they start on their own line
    const reasoning = chatReasoningLine(e, maxText, say);
    if (reasoning !== "") body.push(reasoning);
    for (const p of e.parts ?? []) {
      if (p.type === "text" && p.format === "markdown" && e.role === "assistant") {
        const t = markdownBody(e, p.text, value, 4 * maxText);
        if (t !== "") multi.add(body.push(t) - 1);
      } else if (p.type === "text") {
        const t = oneLineChatText(p.text, maxText);
        if (t !== "") body.push(t);
      } else body.push(`[${describeMedia(kindOfType(p.ref.mediaType), p.ref, say)}]`);
    }
    if (e.status === "failed" || e.status === "rejected")
      body.push(
        `${chatReasonText(e.reason, say)}${e.errorId === undefined ? "" : ` ${say("lu.chat.line.ref", { id: e.errorId })}`}`
      );
    if (e.tools !== undefined && e.tools.length > 0)
      body.push(
        say("lu.chat.line.tools", {
          tools: e.tools.map((t) => `${oneLineChatText(t.name, 64)} ${t.status}`).join(", "),
        })
      );
    // A markdown reply is several lines: the rest are indented under the speaker's.
    const [first = "", ...rest] =
      `${head}: ${body.map((b, k) => (k === 0 ? b : `${multi.has(k) || multi.has(k - 1) ? "\n" : " "}${b}`)).join("")}`
        .trimEnd()
        .split("\n");
    lines.push(first, ...rest.map((l) => (l === "" ? "" : `  ${l}`)));
  }
  return lines;
}
