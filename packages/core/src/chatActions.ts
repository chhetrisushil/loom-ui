// ── The input action vocabulary (U8) ────────────────────────────────────────────────────────────
//
// The action `type`s the chat / input widgets emit, and the idempotency key they mint. Its own tiny
// module so a browser widget carries these and not the host-side acceptance code (`chatHost.ts`).
//
//   SUBMIT_TEXT   { text, key }            a TextInput (a chat composer, a one-line answer)
//   SUBMIT_FORM   { values, key }          a FormInput
//   SELECT        { value, key }           a SelectInput
//   SELECT_MANY   { values, key }          a MultiSelectInput: the whole new choice, not a toggle
//   EDIT_TURN     { turn, text, key }      a Chat: the user revised an earlier turn of their own
//   LOAD_OLDER    { cursor }               a Chat: show earlier turns (a read; carries no key)
//   LOAD_REASONING { cursor }              a Chat: fetch one reply's durable reasoning (a read; carries no key)
//   CHAT_REF_OPEN { entryId, refId, n }    a Chat: the user opened a reference marker (a read; carries no key)
//   MEDIA_ATTACH  { ref }                  the existing U9 `MediaInput` (see `acceptMediaAttach`)

export const SUBMIT_TEXT_ACTION = "SUBMIT_TEXT";
export const SUBMIT_FORM_ACTION = "SUBMIT_FORM";
export const SELECT_ACTION = "SELECT";
export const SELECT_MANY_ACTION = "SELECT_MANY";
export const EDIT_TURN_ACTION = "EDIT_TURN";
export const LOAD_OLDER_ACTION = "LOAD_OLDER";
export const LOAD_REASONING_ACTION = "LOAD_REASONING";
export { CHAT_REF_OPEN_ACTION } from "./chatRefs";

/** The idempotency key shape: short, URL-safe, long enough to be unguessable when random. */
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
export const isSubmitKey = (k: unknown): k is string => typeof k === "string" && KEY.test(k);

let counter = 0;
/**
 * A fresh idempotency key. `crypto.randomUUID` / `getRandomValues` when the platform has them; a
 * time + counter + `Math.random` fallback otherwise (uniqueness, not secrecy, is what it is for:
 * a key is not a credential, the ledger scopes it to the principal and the widget).
 */
export function newSubmitKey(): string {
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (a: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x: number) => x.toString(16).padStart(2, "0")).join("");
  }
  counter = (counter + 1) % 0xffffff;
  return `k${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 12)}`.padEnd(
    16,
    "0"
  );
}
