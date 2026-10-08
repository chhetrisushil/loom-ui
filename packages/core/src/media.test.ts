import { describe, expect, it } from "vitest";
import { defineSemanticCatalog, validateExperience } from "./catalog";
import { genesis } from "./experience";
import { checkKindValue } from "./kindValues";
import { loomCatalogFor } from "./loomCatalog";
import {
  MAX_EMBEDDED_SCAN,
  MEDIA_ALLOWED_PROPS,
  acceptMediaAttach,
  addressProblem,
  checkFileName,
  checkMediaUrl,
  cleanMediaText,
  containsEmbeddedRef,
  describeMedia,
  embeddedRefWarnings,
  formatBytes,
  isActiveMediaType,
  isSameOriginMediaUrl,
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

describe("fix round 1: URL host denylist", () => {
  it.each([
    "https://localhost./x",
    "https://foo.internal./x",
    "https://metadata.google.internal./x",
    "https://intranet./x",
    "https://localhost.localdomain/x",
    "https://[::7f00:1]/x", // IPv4-compatible loopback
    "https://[::a00:1]/x", // IPv4-compatible 10.0.0.1
    "https://[64:ff9b::7f00:1]/x", // NAT64 -> 127.0.0.1
    "https://[64:ff9b::a9fe:a9fe]/x", // NAT64 -> 169.254.169.254
    "https://[64:ff9b:1::1]/x", // local-use NAT64
    "https://[2002:7f00:1::]/x", // 6to4 -> 127.0.0.1
    "https://[2002:a9fe:a9fe::1]/x", // 6to4 -> metadata
    "https://[ff02::1]/x", // multicast
    "https://[fe80::1]/x",
    "https://0.0.0.1/x", // 0.0.0.0/8
    "https://198.18.0.1/x",
    "https://198.19.255.255/x",
    "https://224.0.0.1/x", // multicast
    "https://240.0.0.1/x", // reserved
    "https://255.255.255.255/x",
    "https://192.0.0.8/x",
  ])("refuses %s", (u) => expect(checkMediaUrl(u).ok).toBe(false));

  it.each([
    "https://cdn.example.com./x", // a public host with a root dot is still public
    "https://8.8.8.8/x",
    "https://[2001:4860:4860::8888]/x",
    "https://[64:ff9b::808:808]/x", // NAT64 -> 8.8.8.8
    "https://[2002:808:808::1]/x", // 6to4 -> 8.8.8.8
  ])("still accepts %s", (u) => expect(checkMediaUrl(u).ok).toBe(true));
});

describe("fix round 1: addresses are not paths", () => {
  it.each(["../../etc/passwd", "a/../b", "a/./b", "..", ".", "a/.."])("refuses %s", (a) =>
    expect(addressProblem(a)).toBeDefined()
  );
  it("keeps dotted hash-style handles", () => {
    expect(addressProblem("v1.2/blob.bin")).toBeUndefined();
    expect(addressProblem("sha256:ab.cd")).toBeUndefined();
  });
});

describe("fix round 1: active media types", () => {
  it.each([
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/xml",
    "application/xml",
    "text/javascript",
    "application/ecmascript",
    "application/x-shockwave-flash",
    "application/atom+xml",
  ])("%s is active", (t) => expect(isActiveMediaType(t)).toBe(true));
  it.each(["image/png", "application/pdf", "audio/mpeg", "text/plain", "video/mp4"])(
    "%s is passive",
    (t) => expect(isActiveMediaType(t)).toBe(false)
  );
  it("same-origin spellings", () => {
    expect(isSameOriginMediaUrl("/m/1")).toBe(true);
    expect(isSameOriginMediaUrl("blob:https://a/1")).toBe(true);
    expect(isSameOriginMediaUrl("https://a/1")).toBe(false);
  });
});

describe("fix round 1+2: acceptMediaAttach (host-side)", () => {
  const head = { experienceId: "e", versionHash: "sha256:v" };
  const stamp = { blueprintId: "e@sha256:v", experienceId: "e", versionHash: "sha256:v" };
  const good = {
    address: "sha256:mine0001",
    mediaType: "application/pdf",
    size: 10,
    name: "a.pdf",
  };
  const stored = { mediaType: "application/pdf", size: 10 };
  const act = (ref: unknown, over: Record<string, unknown> = {}) => ({
    type: "MEDIA_ATTACH",
    widgetId: "up",
    payload: { ref },
    viewedVersion: stamp,
    ...over,
  });
  const opts = (
    issued: (a: string, p: string) => { mediaType: string; size?: number } | undefined = (a, p) =>
      a === "sha256:mine0001" && p === "alice" ? stored : undefined
  ) => ({ issued, principal: "alice", current: head });

  it("accepts an issued, fresh, well-formed attach and forces origin=user", () => {
    const r = acceptMediaAttach(act({ ...good, origin: "host" }), opts());
    expect(r).toEqual({ ok: true, ref: { ...good, origin: "user" }, widgetId: "up" });
  });
  it("replaces the CLIENT's mediaType and size with the stored ones", () => {
    const r = acceptMediaAttach(act({ ...good, mediaType: "image/png", size: 1 }), {
      ...opts(() => ({ mediaType: "text/html", size: 5000 })),
    });
    expect(r).toMatchObject({ ok: true, ref: { mediaType: "text/html", size: 5000 } });
    const noSize = acceptMediaAttach(
      act({ ...good, size: 1 }),
      opts(() => ({ mediaType: "application/pdf" }))
    );
    expect(noSize.ok && "size" in noSize.ref).toBe(false);
  });
  it("enforces accept / maxBytes on the STORED values, not the claimed ones", () => {
    expect(
      acceptMediaAttach(act({ ...good, mediaType: "image/png", size: 1 }), {
        ...opts(() => ({ mediaType: "application/pdf", size: 9999 })),
        accept: ["image/*"],
      })
    ).toEqual({ ok: false, reason: "bad-ref" });
    expect(
      acceptMediaAttach(act({ ...good, size: 1 }), {
        ...opts(() => ({ mediaType: "application/pdf", size: 9999 })),
        maxBytes: 100,
      })
    ).toEqual({ ok: false, reason: "bad-ref" });
  });
  it("refuses a widget that is not an upload control", () => {
    expect(acceptMediaAttach(act(good), { ...opts(), isMediaInput: (w) => w === "other" })).toEqual(
      {
        ok: false,
        reason: "not-media-input",
      }
    );
    expect(acceptMediaAttach(act(good), { ...opts(), isMediaInput: (w) => w === "up" }).ok).toBe(
      true
    );
  });
  it("refuses someone else's address (never issued to this principal)", () => {
    expect(acceptMediaAttach(act({ ...good, address: "sha256:bobs0002" }), opts())).toEqual({
      ok: false,
      reason: "not-issued",
    });
    expect(acceptMediaAttach(act(good), { ...opts(), principal: "mallory" })).toEqual({
      ok: false,
      reason: "not-issued",
    });
  });
  it("refuses a stale or unstamped action", () => {
    expect(
      acceptMediaAttach(
        act(good, { viewedVersion: { ...stamp, versionHash: "sha256:old" } }),
        opts()
      )
    ).toEqual({ ok: false, reason: "stale" });
    expect(acceptMediaAttach(act(good, { viewedVersion: undefined }), opts())).toEqual({
      ok: false,
      reason: "stale",
    });
  });
  it.each([
    ["bytes riding along", { ...good, data: "AAAA" }],
    ["a URL address", { ...good, address: "https://x/y" }],
    ["a string", "sha256:mine0001"],
  ])("refuses a malformed ref (%s)", (_l, ref) =>
    expect(acceptMediaAttach(act(ref), opts())).toEqual({ ok: false, reason: "bad-ref" })
  );
  it("refuses other actions and throwing hosts without throwing", () => {
    expect(acceptMediaAttach(act(good, { type: "APPROVE" }), opts())).toEqual({
      ok: false,
      reason: "not-an-attach",
    });
    expect(acceptMediaAttach(null, opts()).ok).toBe(false);
    expect(
      acceptMediaAttach(
        act(good),
        opts(() => {
          throw new Error("x");
        })
      ).ok
    ).toBe(false);
  });
});

describe("fix round 1: embedded references in text props", () => {
  it.each([
    "see https://evil.example/x.png",
    "ｈｔｔｐｓ：／／ｅｖｉｌ", // fullwidth
    "ht\u200btps://evil.example/x",
    "www.evil.example",
    "evil.example/a.png",
    "ref sha256:0123456789abcdef0123 here",
    "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "javascript:alert(1)",
    "java\u200bscript:alert(1)", // zero-width splitter
  ])("detects %s", (t) => expect(containsEmbeddedRef(t)).toBe(true));
  it.each(["Q3 revenue by region", "Profile: complete", "v1.2 release notes", "ratio 3:4"])(
    "leaves %s alone",
    (t) => expect(containsEmbeddedRef(t)).toBe(false)
  );
  it("media nodes: embedded refs are errors; non-media nodes: warnings", () => {
    expect(
      mediaPropFindings("Image", "n", { caption: "from https://evil.example/x" }).map((f) => f.code)
    ).toContain("media-embedded-ref");
    expect(embeddedRefWarnings("n", { text: "see https://docs.example.com" })[0]?.severity).toBe(
      "warn"
    );
  });
});

describe("fix round 2: linear embedded-ref scan", () => {
  const BOUND_MS = 250;
  const time = (f: () => unknown): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  it.each([
    ["a.", "a.".repeat(50_000)],
    ["a", "a".repeat(100_000)],
    ["a.a/", "a.a/".repeat(25_000)],
    ["scheme runs", "a+".repeat(50_000)],
    ["://", "a://".repeat(25_000)],
    ["www.", "www.".repeat(25_000)],
    ["hex tags", "abc:".repeat(25_000)],
    ["baf", "baf".repeat(33_000)],
    ["Qm", "Qm".repeat(50_000)],
  ])("a 100 KB %s string is handled well under the bound", (_l, text) => {
    expect(time(() => containsEmbeddedRef(text))).toBeLessThan(BOUND_MS);
    expect(time(() => mediaPropFindings("Image", "n", { caption: text }))).toBeLessThan(BOUND_MS);
    expect(time(() => embeddedRefWarnings("n", { text }))).toBeLessThan(BOUND_MS);
  });
  it("text over the scan cap is reported, not scanned", () => {
    const long = "x".repeat(MAX_EMBEDDED_SCAN + 1);
    expect(mediaPropFindings("Image", "n", { caption: long }).map((f) => f.code)).toEqual([
      "media-prop-too-long",
    ]);
    expect(embeddedRefWarnings("n", { text: long }).map((f) => f.code)).toEqual([
      "text-too-long-to-scan",
    ]);
    expect(containsEmbeddedRef(long)).toBe(true);
    expect(containsEmbeddedRef("x".repeat(MAX_EMBEDDED_SCAN))).toBe(false);
  });
  it("the hand-written scanners keep the old verdicts", () => {
    for (const t of [
      "https://a",
      "x-y+z.1://q",
      "a.b.example.com/p",
      "evil.example/x",
      "see (evil.io/a)",
    ])
      expect(containsEmbeddedRef(t)).toBe(true);
    for (const t of [
      "http:// ",
      "://x",
      "1://x",
      "a.b/",
      "evil.e/x",
      "a.example.com /x",
      "x.1/",
      "plain words",
    ])
      expect(containsEmbeddedRef(t)).toBe(false);
  });
  it("documented false positive: name.js/name reads as host/path", () => {
    expect(containsEmbeddedRef("Node.js/React")).toBe(true);
  });
});

describe("fix round 2: absolute same-origin URLs, active-type essence, hosts", () => {
  it("an absolute URL on the app origin is same-origin; others are not", () => {
    expect(isSameOriginMediaUrl("https://app.example.com/m/1", "https://app.example.com")).toBe(
      true
    );
    expect(isSameOriginMediaUrl("https://cdn.example.com/m/1", "https://app.example.com")).toBe(
      false
    );
    expect(isSameOriginMediaUrl("https://app.example.com:8443/m", "https://app.example.com")).toBe(
      false
    );
    expect(isSameOriginMediaUrl("https://app.example.com/m")).toBe(false); // no appOrigin: cannot tell
  });
  it.each([
    "text/html; charset=utf-8",
    " TEXT/HTML ;x=y",
    "text/xsl",
    "application/hta",
    "text/x-scriptlet",
    "text/cache-manifest",
  ])("%s is active", (t) => expect(isActiveMediaType(t)).toBe(true));
  it.each([
    "https://localhost../x",
    "https://foo.internal.../x",
    "https://[fec0::1]/x",
    "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x",
  ])("refuses %s", (u) => expect(checkMediaUrl(u).ok).toBe(false));
  it("a public 2001: address is still fine", () => {
    expect(checkMediaUrl("https://[2001:4860:4860::8888]/x").ok).toBe(true);
  });
});

describe("fix round 1: file names vs media type", () => {
  it("a disguised executable is exposed and its misleading extension is dropped from the download name", () => {
    const r = checkFileName("invoice.pdf.exe", "application/pdf");
    expect(r.mismatch).toBe(true);
    expect(r.display).toBe("invoice.pdf.exe (application/pdf)");
    expect(r.download).toBe("invoice.pdf");
  });
  it("an honest or harmless name is untouched", () => {
    expect(checkFileName("report.pdf", "application/pdf").mismatch).toBe(false);
    expect(checkFileName("setup.exe", "application/x-msdownload").mismatch).toBe(false);
    expect(checkFileName("page.html", "text/html").mismatch).toBe(false);
    expect(checkFileName("photo", "image/png")).toMatchObject({
      mismatch: false,
      download: "photo",
    });
  });
  it("page.html declared as a PDF is a mismatch", () => {
    expect(checkFileName("page.html", "application/pdf").mismatch).toBe(true);
  });
});
