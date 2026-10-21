// `@loom-ui/core/chat-ui` — the part of the chat surface a BROWSER WIDGET needs (U8): the transcript
// contract and its words, the untrusted-text cleaner, the input specs and their validators, and the
// action vocabulary with its idempotency key. Zod-free and DOM-free.
//
// It is a narrower entry than `@loom-ui/core/chat` on purpose. core is CommonJS, so a bundler cannot
// drop an unused module behind a barrel: importing `@loom-ui/core/chat` would carry `ChatFeed` (the
// fold over loom's API), the host-side acceptance and write-back code, and the catalogue guard into a
// page that only draws a transcript. The host and the folding live in `@loom-ui/core/chat`.
export * from "./chatValue";
export * from "./chatText";
export * from "./chatForm";
export * from "./chatActions";
export { MAX_CHAT_REFS, splitRefMarkers, type RefSegment } from "./chatRefs";
export * from "./chatWords";
export { describeMedia } from "./mediaText";
export { mediaFamily } from "./mediaRef";
