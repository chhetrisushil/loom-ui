import type { ChatEntry } from "@loomwork/ui-core/chat-ui";
import type { TemplateResult } from "lit";

// ── Chat entry accessories: host content drawn under one transcript entry ─────────────────────
//
// A host sometimes has something of its own to show with a reply: sources, a chart composed from
// the answer, follow-up actions. It cannot reach into `lu-chat`'s shadow root (and must not depend
// on its markup), and a light-DOM slot is not reachable when the chat is mounted by a view inside
// another shadow root. So the content is asked for through the renderer's options, like `media`:
// `createChatLitRegistry({ chatAccessories })`, and drawn by the widget inside the entry's article.

/** Which entry an accessory is asked for. Ids only: the host already holds the transcript. */
export interface ChatEntryRef {
  /** `t<turn>.<role>`: stable for the life of the turn's slot (a streaming reply keeps it). */
  readonly id: string;
  readonly turn: number;
  readonly role: ChatEntry["role"];
  readonly status: ChatEntry["status"];
}

/**
 * What to draw: a DOM node the HOST owns (return the same node each time and it is never remounted),
 * a Lit `TemplateResult` (only when the host renders with the same `lit` as this package), or
 * `null` / `undefined` for nothing. The content is host-trusted markup: the widget does not sanitize
 * it, so never build it from untrusted text as HTML.
 */
export type ChatAccessoryContent = Node | TemplateResult | null | undefined;

export interface ChatEntryAccessories {
  /**
   * The content for `entry` of the chat widget `widgetId`. Called when an entry first appears, when its
   * `status` changes (a streaming reply settling) and when `changed` names it; otherwise the last
   * answer is kept. Never called for a `restricted` entry. Keep it cheap and synchronous.
   */
  render(entry: ChatEntryRef, chat: { readonly widgetId: string }): ChatAccessoryContent;
  /**
   * Called once by each mounted chat widget with its `changed` callback; return the unsubscribe, called
   * when the widget leaves the page. `changed(entryId)` asks again for that entry only (for example
   * when the host's content for it is ready); `changed()` asks again for every entry.
   */
  subscribe?(changed: (entryId?: string) => void): () => void;
}
