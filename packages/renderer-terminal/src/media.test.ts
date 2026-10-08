import { describeMedia } from "@loom-ui/core";
import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createLoomUiTerminalRegistry } from "./registry";

const b = { projectionId: "hydration", path: "values.h" };
const ADDR = "sha256:0123456789abcdef0123456789abcdef";
const ref = (over: Record<string, unknown> = {}) => ({
  address: ADDR,
  mediaType: "image/png",
  size: 2048,
  name: "chart.png",
  ...over,
});
const draw = (
  kind: string,
  value: unknown,
  opts: Parameters<typeof createLoomUiTerminalRegistry>[0] = {}
): string =>
  (createLoomUiTerminalRegistry(opts).get(kind) as (w: unknown, v: unknown) => string)(
    customWidget$({ kind, id: "m", title: "Pic", binding: b }),
    value
  );

describe("terminal media", () => {
  it("prints the shared one-line description, an untrusted marker and a non-reversible tag — never any part of the address", () => {
    const out = draw("Image", ref());
    expect(out).toContain(describeMedia("Image", ref() as never));
    expect(out).toContain("[untrusted]");
    expect(out).toMatch(/ ref#[0-9a-f]{8}$/);
    expect(out).not.toContain(ADDR);
    expect(out).not.toContain("0123456789"); // no part of the address, not even a prefix
    expect(out.startsWith("Pic: ")).toBe(true);
  });

  it("works for every display kind and honours chrome: host", () => {
    for (const [kind, type] of [
      ["Audio", "audio/mpeg"],
      ["Video", "video/mp4"],
      ["File", "application/pdf"],
    ] as const)
      expect(draw(kind, ref({ mediaType: type }), { chrome: "host" })).toMatch(
        new RegExp(`^${kind === "File" ? "file" : kind.toLowerCase()} chart.png`)
      );
  });

  it("a host that vouches drops the marker, except for user-origin media", () => {
    const media = { trusted: () => true };
    expect(draw("Image", ref(), { media })).not.toContain("[untrusted]");
    expect(draw("Image", ref({ origin: "user" }), { media })).toContain("[untrusted]");
  });

  it("prints a host link only after re-checking it", () => {
    const link = (u: string) => ({ media: { link: () => u } });
    expect(draw("Image", ref(), link("https://cdn.example.com/m/1?sig=x"))).toContain(
      "https://cdn.example.com/m/1?sig=x"
    );
    for (const bad of [
      "javascript:alert(1)",
      "http://cdn.example.com/x",
      "https://127.0.0.1/x",
      "file:///etc/passwd",
    ]) {
      const out = draw("Image", ref(), link(bad));
      expect(out).not.toContain(bad);
      expect(out).toMatch(/ref#[0-9a-f]{8}/);
    }
  });

  it("the tag is the same for short and long addresses and reveals no part of either", () => {
    for (const address of ["a1", "sha256:ab", ADDR]) {
      const out = draw("Image", ref({ address }));
      expect(out).toMatch(/ref#[0-9a-f]{8}$/);
      expect(out.slice(out.indexOf("[untrusted]"))).not.toContain(address);
    }
  });

  it("untrusted active content is blocked: no link, no tag; a same-origin link is refused for untrusted media", () => {
    const media = { link: () => "https://cdn.example.com/x" };
    const out = draw("File", ref({ mediaType: "text/html" }), { media });
    expect(out).toContain("blocked (active content type)");
    expect(out).not.toContain("cdn.example.com");
    expect(draw("Image", ref(), { media: { link: () => "/media/1" } })).toMatch(/ref#/);
    expect(
      draw("Image", ref(), { media: { link: () => "/media/1", trusted: () => true } })
    ).toContain("/media/1");
    // trusted active types are the host's call
    expect(
      draw("File", ref({ mediaType: "image/svg+xml" }), { media: { trusted: () => true } })
    ).not.toContain("blocked");
  });

  it("a declared size over the limit prints no link or handle to open", () => {
    const out = draw("Image", ref({ size: 40 * 1024 * 1024 }), {
      media: { link: () => "https://cdn.example.com/x" },
    });
    expect(out).toContain("too large to open");
    expect(out).not.toContain("cdn.example.com");
  });

  it("strips control and bidi characters from a hostile name and alt", () => {
    const out = draw("Image", ref({ name: "a\u001b[31m\u202eb.png", alt: "x\u0007y" }));
    expect([...out].filter((c) => ["\u001b", "\u202e", "\u0007"].includes(c))).toEqual([]);
  });

  it("a value that fails the contract prints the contract error, not the value", () => {
    for (const bad of [
      ref({ data: "A".repeat(500) }),
      ref({ address: "https://internal/x" }),
      "sha256:abc",
      ref({ mediaType: "audio/mpeg" }),
    ]) {
      const out = draw("Image", bad);
      expect(out.startsWith("✗ ")).toBe(true);
      expect(out).not.toContain("AAAA");
      expect(out).not.toContain("internal");
    }
  });

  it("an undefined value is the usual dash; an upload control says it is a web control", () => {
    expect(draw("Image", undefined)).toBe("Pic: —");
    const input = createLoomUiTerminalRegistry().get("MediaInput") as (w: unknown) => string;
    expect(input(customWidget$({ kind: "MediaInput", id: "u", title: "Attach" }))).toBe(
      "Attach: [file upload — available on the web]"
    );
  });
});
