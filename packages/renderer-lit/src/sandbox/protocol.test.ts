import { describe, expect, it } from "vitest";
import {
  SANDBOX_ALLOW,
  SANDBOX_MARKER,
  buildSandboxSrcdoc,
  frameMessage,
  hostMessage,
  parseFrameMessage,
} from "./protocol.js";

// ── Security invariants (these guard the isolation; do not relax) ───────────────

describe("sandbox isolation invariants", () => {
  it("grants ONLY allow-scripts — never allow-same-origin", () => {
    expect(SANDBOX_ALLOW).toBe("allow-scripts");
    // The one token that would breach origin isolation must never appear.
    expect(SANDBOX_ALLOW).not.toContain("allow-same-origin");
    expect(SANDBOX_ALLOW.split(/\s+/)).toEqual(["allow-scripts"]);
  });

  it("the bootstrap only accepts messages from the host window", () => {
    const doc = buildSandboxSrcdoc();
    expect(doc).toContain("e.source !== window.parent");
  });

  it("the bootstrap ships a network-blocking CSP (no exfiltration)", () => {
    const doc = buildSandboxSrcdoc();
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("Content-Security-Policy");
    // No network sinks are opened up.
    expect(doc).not.toContain("connect-src http");
  });

  it("the bootstrap tags outbound messages with the marker and announces ready", () => {
    const doc = buildSandboxSrcdoc();
    expect(doc).toContain(JSON.stringify(SANDBOX_MARKER));
    expect(doc).toContain('type: "ready"');
  });
});

// ── Message protocol ────────────────────────────────────────────────────────────

describe("hostMessage / frameMessage", () => {
  it("stamp the marker onto the payload", () => {
    expect(hostMessage({ type: "render", data: { a: 1 } })).toEqual({
      [SANDBOX_MARKER]: true,
      type: "render",
      data: { a: 1 },
    });
    expect(frameMessage({ type: "ready" })[SANDBOX_MARKER]).toBe(true);
  });
});

describe("parseFrameMessage", () => {
  const mark = (m: Record<string, unknown>) => ({ [SANDBOX_MARKER]: true, ...m });

  it("rejects anything without the marker", () => {
    expect(parseFrameMessage({ type: "action", action: "x" })).toBeNull();
    expect(parseFrameMessage(null)).toBeNull();
    expect(parseFrameMessage("action")).toBeNull();
  });

  it("parses a well-formed action, carrying its context", () => {
    expect(
      parseFrameMessage(mark({ type: "action", action: "approve", context: { id: 7 } }))
    ).toEqual({ type: "action", action: "approve", context: { id: 7 } });
  });

  it("rejects an action without a string action name", () => {
    expect(parseFrameMessage(mark({ type: "action" }))).toBeNull();
    expect(parseFrameMessage(mark({ type: "action", action: 5 }))).toBeNull();
  });

  it("parses ready, resize (numeric), and error", () => {
    expect(parseFrameMessage(mark({ type: "ready" }))).toEqual({ type: "ready" });
    expect(parseFrameMessage(mark({ type: "resize", height: 120 }))).toEqual({
      type: "resize",
      height: 120,
    });
    expect(parseFrameMessage(mark({ type: "error", message: "boom" }))).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("rejects a resize without a numeric height and an unknown type", () => {
    expect(parseFrameMessage(mark({ type: "resize", height: "tall" }))).toBeNull();
    expect(parseFrameMessage(mark({ type: "nope" }))).toBeNull();
  });

  it("defaults a malformed error message rather than dropping the signal", () => {
    expect(parseFrameMessage(mark({ type: "error" }))).toEqual({ type: "error", message: "error" });
  });
});
