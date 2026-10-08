import { oneLineChatText } from "./chatText";
import { type ChatEntry, type ChatValue, sameChatActor } from "./chatValue";
import { mediaFamily } from "./mediaRef";
import { describeMedia } from "./mediaText";

// ── Words both renderers share ───────────────────────────────────────────────────────────────────

/** The fixed words for a `reason` token. The token is the source's; the sentence is ours. */
const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "model-error": "The assistant ran into a problem.",
  denied: "That was not permitted.",
  "turn-failed": "The turn could not be completed.",
  cancelled: "The turn was cancelled.",
  "too-long": "The message was too long.",
  "prompt-too-large": "The message was too large to answer.",
  malformed: "The message was not understood.",
  unauthenticated: "The message could not be verified.",
  replayed: "The message was already received.",
  stale: "The message arrived too late.",
  "not-a-participant": "You are not a participant in this conversation.",
});
const GENERIC_REASON = "The message was not processed.";

/** One fixed sentence for a failure / rejection reason; unknown tokens get the generic sentence, never their own text. */
export function chatReasonText(reason: string | undefined): string {
  return reason !== undefined && Object.hasOwn(REASON_TEXT, reason)
    ? (REASON_TEXT[reason] as string)
    : GENERIC_REASON;
}

/** Is this user entry the viewer's own? (No `asker` = an owner-only conversation: the viewer is the owner.) */
export function isOwnChatEntry(entry: ChatEntry, viewer: ChatValue["viewer"]): boolean {
  if (entry.role !== "user") return false;
  if (entry.asker === undefined) return true;
  return sameChatActor(entry.asker, viewer);
}

/** `Alice`, from an actor; never the tenant. Untrusted text, cleaned and bounded. */
export function chatActorLabel(entry: ChatEntry): string {
  const a = entry.asker?.actor;
  return a === undefined ? "" : oneLineChatText(a, 60);
}

/** Who is speaking, in words: `You`, `Alice`, `Assistant`, `Notice`. */
export function chatSpeaker(entry: ChatEntry, viewer: ChatValue["viewer"]): string {
  if (entry.role === "assistant") return "Assistant";
  if (entry.role === "system") return "Notice";
  if (isOwnChatEntry(entry, viewer)) return "You";
  return chatActorLabel(entry) || "User";
}

/** The status note, in words (`interrupted`, `replying`, ...), or `""` for a plain complete entry. */
export function chatStatusNote(entry: ChatEntry): string {
  const parts: string[] = [];
  if (entry.status === "streaming") parts.push("replying");
  else if (entry.status === "interrupted") parts.push("interrupted");
  else if (entry.status === "failed") parts.push("failed");
  else if (entry.status === "rejected") parts.push("not accepted");
  if (entry.editOf !== undefined) parts.push(`edit of turn ${entry.editOf}`);
  return parts.join(", ");
}

const kindOfType = (mediaType: string): string =>
  (["Image", "Audio", "Video"] as const).find((k) =>
    mediaType.startsWith(mediaFamily(k) as string)
  ) ?? "File";

/**
 * A transcript as plain lines — what the terminal prints and what a screen reader's summary says.
 * Every text is cleaned and bounded; a restricted entry is a bare placeholder; a failure is the
 * fixed sentence plus its reference id. No address, URL or timestamp appears.
 */
export function chatTranscriptLines(
  value: ChatValue,
  options: { maxText?: number } = {}
): string[] {
  const maxText = options.maxText ?? 2000;
  const lines: string[] = [];
  for (const e of value.entries) {
    if (e.status === "restricted") {
      const by = chatActorLabel(e);
      lines.push(`[restricted ${e.role} turn${by === "" ? "" : ` from ${by}`}]`);
      continue;
    }
    const note = chatStatusNote(e);
    const head = `${chatSpeaker(e, value.viewer)}${note === "" ? "" : ` (${note})`}`;
    const body: string[] = [];
    for (const p of e.parts ?? []) {
      if (p.type === "text") {
        const t = oneLineChatText(p.text, maxText);
        if (t !== "") body.push(t);
      } else body.push(`[${describeMedia(kindOfType(p.ref.mediaType), p.ref)}]`);
    }
    if (e.status === "failed" || e.status === "rejected")
      body.push(
        `${chatReasonText(e.reason)}${e.errorId === undefined ? "" : ` (ref ${e.errorId})`}`
      );
    if (e.tools !== undefined && e.tools.length > 0)
      body.push(
        `[tools: ${e.tools.map((t) => `${oneLineChatText(t.name, 64)} ${t.status}`).join(", ")}]`
      );
    lines.push(`${head}: ${body.join(" ")}`.trimEnd());
  }
  return lines;
}
