import { describe, expect, it } from "vitest";
import { defineSemanticCatalog, validateExperience } from "./catalog";
import { genesis } from "./experience";
import { checkKindValue } from "./kindValues";
import { loomCatalogFor } from "./loomCatalog";
import {
  MEDIA_ALLOWED_PROPS,
  addressProblem,
  checkMediaUrl,
  cleanMediaText,
  describeMedia,
  formatBytes,
  matchesAccept,
  mediaCatalogEntries,
  mediaPropFindings,
  safeFileName,
} from "./media";
import { checkKindValue as zodCheck } from "./values";

const ok = { address: "sha256:0123abcd", mediaType: "image/png", size: 10, name: "a.png" };

describe("MediaRef contract", () => {
  it("accepts a well-formed ref for its kind's family; File takes any type", () => {
    expect(checkKindValue("Image", ok)).toEqual({ ok: true });
    expect(checkKindValue("File", { ...ok, mediaType: "application/pdf" })).toEqual({ ok: true });
    expect(checkKindValue("Audio", ok).ok).toBe(false); // image/* is not audio/*
    expect(checkKindValue("Video", { ...ok, mediaType: "video/mp4" })).toEqual({ ok: true });
  });

  it.each([
    ["a URL", { ...ok, address: "https://evil.example/x" }],
    ["a protocol-relative locator", { ...ok, address: "//evil.example/x" }],
    ["an absolute path", { ...ok, address: "/etc/passwd" }],
    ["whitespace", { ...ok, address: "a b" }],
    ["a javascript: scheme", { ...ok, address: "javascript:alert(1)" }],
    ["an empty address", { ...ok, address: "" }],
    ["an over-long address", { ...ok, address: "a".repeat(513) }],
    ["a mediaType with parameters", { ...ok, mediaType: "image/png; charset=x" }],
    ["an upper-case mediaType", { ...ok, mediaType: "IMAGE/PNG" }],
    ["a negative size", { ...ok, size: -1 }],
    ["a fractional size", { ...ok, size: 1.5 }],
    ["an absurd size", { ...ok, size: 2 ** 50 }],
    ["inline bytes riding along", { ...ok, data: "AAAA" }],
    ["a locator riding along", { ...ok, url: "https://x" }],
    ["an unknown origin", { ...ok, origin: "admin" }],
    ["a bare string", "sha256:ab"],
    ["an array", [ok]],
  ])("refuses %s", (_label, value) => {
    expect(checkKindValue("Image", value).ok).toBe(false);
    expect(zodCheck("Image", value).ok).toBe(false);
  });

  it("never echoes the offending value into its message", () => {
    const secret = "sha256:SECRET-ADDR-http://x";
    for (const v of [
      { ...ok, address: secret },
      { ...ok, mediaType: secret },
      { ...ok, name: secret.repeat(40) },
      { ...ok, [secret]: 1 },
    ]) {
      const r = checkKindValue("Image", v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.finding.message).not.toContain("SECRET");
    }
  });

  it("a MediaInput is static: a value reaching it is a defect", () => {
    expect(checkKindValue("MediaInput", undefined)).toEqual({ ok: true });
    expect(checkKindValue("MediaInput", ok).ok).toBe(false);
  });

  it("addressProblem accepts hash-style handles", () => {
    expect(addressProblem("sha256:abc")).toBeUndefined();
    expect(addressProblem("blobs/2026/ab-cd_1.0")).toBeUndefined();
  });
});

describe("checkMediaUrl (no SSRF, no script vectors)", () => {
  it.each([
    "https://cdn.example.com/m/abc?sig=1",
    "blob:https://app.example.com/1-2-3",
    "/media/abc?sig=1",
  ])("accepts %s", (u) => expect(checkMediaUrl(u).ok).toBe(true));

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "http://cdn.example.com/x",
    "https://user:pw@cdn.example.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://2130706433/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://172.20.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://[fd00::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://metadata.internal/x",
    "https://intranet/x",
    "//cdn.example.com/x",
    "/ok\\..\\evil",
    "https://a.example.com/x y",
    "",
    42,
  ])("refuses %s", (u) => expect(checkMediaUrl(u as never).ok).toBe(false));

  it("policy widens only what it names", () => {
    expect(checkMediaUrl("http://cdn.example.com/x", { allowInsecure: true }).ok).toBe(true);
    expect(checkMediaUrl("https://localhost/x", { allowPrivateHosts: true }).ok).toBe(true);
    expect(checkMediaUrl("/x", { allowRelative: false }).ok).toBe(false);
    expect(checkMediaUrl("javascript:1", { allowInsecure: true, allowPrivateHosts: true }).ok).toBe(
      false
    );
  });
});

describe("a composer cannot author a media reference", () => {
  it("refuses undeclared-by-framework props whatever the catalogue says, and literal addresses/URLs", () => {
    const f = (props: Record<string, unknown>) =>
      mediaPropFindings("Image", "n", props).map((x) => x.code);
    expect(f({ src: "https://x" })).toContain("media-prop-forbidden");
    expect(f({ address: "sha256:ab" })).toContain("media-prop-forbidden");
    expect(f({ autoplay: true })).toContain("media-prop-forbidden");
    expect(f({ caption: "https://evil.example/x.png" })).toContain("media-literal-ref");
    expect(f({ caption: "sha256:0123456789abcdef0123" })).toContain("media-literal-ref");
    expect(f({ caption: "data:image/png;base64,AAAA" })).toContain("media-literal-ref");
    expect(f({ caption: { key: "k", fallback: "https://evil.example/x" } })).toContain(
      "media-literal-ref"
    );
    expect(f({ alt: "A chart of revenue", caption: "Q3" })).toEqual([]);
    expect(Object.keys(MEDIA_ALLOWED_PROPS).sort()).toEqual([
      "Audio",
      "File",
      "Image",
      "MediaInput",
      "Video",
    ]);
  });

  it("validates MediaInput accept / maxBytes", () => {
    const f = (props: Record<string, unknown>) =>
      mediaPropFindings("MediaInput", "n", props).map((x) => x.code);
    expect(f({ accept: ["image/*", "application/pdf"], maxBytes: 1000 })).toEqual([]);
    expect(f({ accept: ["*/*"] })).toEqual(["media-prop-shape"]);
    expect(f({ accept: [] })).toEqual(["media-prop-shape"]);
    expect(f({ accept: "image/*" })).toEqual(["media-prop-shape"]);
    expect(f({ maxBytes: -5 })).toEqual(["media-prop-shape"]);
  });

  const meta = { author: "a", createdAt: "2026-10-08T00:00:00Z", sourceKind: "prompt" };
  const base = genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta });
  const node = (extra: Record<string, unknown>) =>
    ({
      ...base,
      root: {
        id: "r",
        order: "V",
        kind: "container",
        direction: "column",
        span: 12,
        children: [
          {
            id: "m",
            order: "a",
            kind: "semantic",
            type: "Image",
            typeVersion: "1.0.0",
            span: 6,
            props: {},
            ...extra,
          },
        ],
      },
      providers: {},
    }) as never;

  it("validateExperience: even a catalogue that DECLARES `src` cannot admit it; an unbound image is an error", () => {
    const entries = mediaCatalogEntries();
    const evil = defineSemanticCatalog({
      id: "evil",
      entries: entries.map((e) =>
        e.name === "Image"
          ? {
              ...e,
              props: [...e.props, "src"],
              surfaces: {
                web: {
                  kind: "Image",
                  props: ["alt", "caption", "src"],
                  binding: "required" as const,
                },
              },
            }
          : e
      ),
    });
    const withSrc = validateExperience(
      node({ props: { src: "https://x/y.png" }, binding: { handle: "h", priority: "P1" } }),
      evil,
      "web"
    );
    expect(withSrc.findings.map((f) => f.code)).toContain("media-prop-forbidden");
    const unbound = validateExperience(
      node({}),
      defineSemanticCatalog({ id: "m", entries }),
      "web"
    );
    expect(unbound.findings.map((f) => f.code)).toContain("media-unbound");
  });

  it("the standard media entries compile to a clean loom catalogue on web and terminal", () => {
    const cat = defineSemanticCatalog({ id: "m", entries: mediaCatalogEntries() });
    for (const surface of ["web", "terminal"]) {
      const { catalog, findings } = loomCatalogFor(cat, surface);
      expect(findings).toEqual([]);
      expect(catalog.entries.map((e) => e.kind).sort()).toEqual([
        "Audio",
        "File",
        "Image",
        "MediaInput",
        "Video",
      ]);
    }
  });
});

describe("display helpers", () => {
  it("cleanMediaText strips controls and bidi marks and bounds", () => {
    expect(cleanMediaText("a\u202eb\u0000c\n d")).toBe("a b c d");
    expect(cleanMediaText("x".repeat(500), 10)).toHaveLength(10);
    expect(cleanMediaText(5)).toBe("");
  });
  it("safeFileName has no separators, no leading dot, never empty", () => {
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("\u202e")).toBe("download");
  });
  it("formatBytes and describeMedia are fixed text", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MiB");
    expect(
      describeMedia("File", {
        address: "a",
        mediaType: "application/pdf",
        name: "r.pdf",
        size: 2048,
      })
    ).toBe("file r.pdf (application/pdf, 2 KiB)");
  });
  it("matchesAccept", () => {
    expect(matchesAccept("image/png", ["image/*"])).toBe(true);
    expect(matchesAccept("application/pdf", ["image/*"])).toBe(false);
    expect(matchesAccept("application/pdf", ["application/pdf"])).toBe(true);
    expect(matchesAccept("anything/x", undefined)).toBe(true);
  });
});
