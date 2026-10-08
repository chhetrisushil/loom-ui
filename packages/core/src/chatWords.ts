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
  "edit-invalid": "That edit could not be applied to the earlier message.",
});
const GENERIC_REASON = "The message was not processed.";

/** One fixed sentence for a failure / rejection reason; unknown tokens get the generic sentence, never their own text. */
export function chatReasonText(reason: string | undefined): string {
  return reason !== undefined && Object.hasOwn(REASON_TEXT, reason)
    ? (REASON_TEXT[reason] as string)
    : GENERIC_REASON;
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
export function chatSpeaker(entry: ChatEntry, who: ChatWho): string {
  if (entry.role === "assistant") return "Assistant";
  if (entry.role === "system") return "Notice";
  if (isOwnChatEntry(entry, who)) return "You";
  const name = chatActorLabel(entry);
  return name === "" ? "User" : `User "${name}"`;
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
    const head = `${chatSpeaker(e, value)}${note === "" ? "" : ` (${note})`}`;
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
