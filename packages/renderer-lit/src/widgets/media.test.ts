import type { MediaRequest, MediaResolution, MediaResolver } from "@loom-ui/core/media";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./lu-media";

// U9: the media widgets. The address is a capability and never a locator: it must not appear in any
// rendered state, a resolver's refusal and failure look identical, and only a re-checked
// viewer-scoped URL ever reaches an element.

const b = { projectionId: "hydration", path: "values.h" };
type Mounted = HTMLElement & { updateComplete: Promise<unknown> };
const ADDR = "sha256:deadbeefcafe0001";
const ref = (over: Record<string, unknown> = {}) => ({
  address: ADDR,
  mediaType: "image/png",
  size: 1024,
  name: "chart.png",
  ...over,
});
const settle = async (el: Mounted) => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
};
const mount = async (tag: string, props: Record<string, unknown>): Promise<Mounted> => {
  const el = document.createElement(tag) as Mounted;
  Object.assign(el, props);
  document.body.appendChild(el);
  await settle(el);
  return el;
};
const widget = (kind: string, props: Record<string, unknown> = {}, id = "m") =>
  customWidget$({ kind, id, title: "Media", binding: b, props });
const ok = (
  url = "https://cdn.example.com/m/1?sig=x",
  extra: Partial<MediaResolution & { ok: true }> = {}
): MediaResolution => ({
  ok: true,
  url,
  ...extra,
});
const resolverOf = (
  answer: MediaResolution | (() => Promise<MediaResolution>)
): MediaResolver & { calls: MediaRequest[] } => {
  const calls: MediaRequest[] = [];
  const fn: MediaResolver = async (req) => {
    calls.push(req);
    return typeof answer === "function" ? answer() : answer;
  };
  return Object.assign(fn, { calls });
};
const html = (el: HTMLElement) => el.shadowRoot?.innerHTML ?? "";
const q = <T extends Element>(el: HTMLElement, sel: string) =>
  el.shadowRoot?.querySelector(sel) as T | null;

// happy-dom's IntersectionObserver never fires; "no observer" is the environment-free path (resolve at once).
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lu-image", () => {
  it("draws a re-checked viewer URL with safe attributes, marks it untrusted, and shows no address", async () => {
    const resolver = resolverOf(ok());
    const el = await mount("lu-image", {
      widget: widget("Image", { alt: 'a "chart"\u202e <script>x</script>' }),
      value: ref(),
      media: { resolver },
    });
    const img = q<HTMLImageElement>(el, "img");
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/m/1?sig=x");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("alt")).not.toContain("\u202e");
    expect(q(el, "script")).toBeNull();
    expect(q(el, "[data-untrusted]")).not.toBeNull(); // the host did not vouch
    expect(html(el)).not.toContain(ADDR);
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toMatchObject({ kind: "Image", widgetId: "m", purpose: "display" });
    expect(Object.isFrozen(resolver.calls[0]?.ref)).toBe(true);
  });

  it("a host that vouches gets no marker, except for user-origin media, which is never trusted", async () => {
    const trusted = await mount("lu-image", {
      widget: widget("Image"),
      value: ref(),
      media: { resolver: resolverOf(ok(undefined, { trusted: true })) },
    });
    expect(q(trusted, "[data-untrusted]")).toBeNull();
    const user = await mount("lu-image", {
      widget: widget("Image"),
      value: ref({ origin: "user" }),
      media: { resolver: resolverOf(ok(undefined, { trusted: true })) },
    });
    expect(q(user, "[data-untrusted]")).not.toBeNull();
  });

  it("policy `block` draws a placeholder for untrusted media, with no element and no URL", async () => {
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: ref(),
      media: { resolver: resolverOf(ok()), policy: { untrusted: "block" } },
    });
    expect(q(el, "img")).toBeNull();
    expect(q(el, '[data-media-state="blocked"]')).not.toBeNull();
    expect(html(el)).not.toContain("cdn.example.com");
  });

  const unavailable = [
    ["a refusal", () => resolverOf({ ok: false, reason: "denied" })],
    ["a missing blob", () => resolverOf({ ok: false, reason: "not-found" })],
    ["a resolver that throws", () => resolverOf(() => Promise.reject(new Error(`boom ${ADDR}`)))],
    ["a javascript: URL", () => resolverOf(ok("javascript:alert(1)"))],
    ["a data: URL", () => resolverOf(ok("data:text/html,<script>1</script>"))],
    ["a plain-http URL", () => resolverOf(ok("http://cdn.example.com/x"))],
    [
      "a link-local (metadata) URL",
      () => resolverOf(ok("https://169.254.169.254/latest/meta-data")),
    ],
    ["a URL with credentials", () => resolverOf(ok("https://u:p@cdn.example.com/x"))],
    ["a non-object answer", () => resolverOf(null as never)],
  ] as const;
  it.each(unavailable)("%s is ONE fixed, address-free unavailable state", async (_l, make) => {
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: ref(),
      media: { resolver: make() },
    });
    expect(q(el, "img")).toBeNull();
    const state = q(el, "[data-media-state]");
    expect(state?.getAttribute("data-media-state")).toBe("unavailable");
    expect(state?.textContent?.trim()).toBe("Media unavailable");
    expect(html(el)).not.toContain(ADDR);
    expect(html(el)).not.toContain("boom");
  });

  it("with no resolver nothing is loaded: unavailable", async () => {
    const el = await mount("lu-image", { widget: widget("Image"), value: ref() });
    expect(q(el, "img")).toBeNull();
    expect(q(el, '[data-media-state="unavailable"]')).not.toBeNull();
  });

  it("refuses a declared size over the limit BEFORE calling the resolver", async () => {
    const resolver = resolverOf(ok());
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: ref({ size: 40 * 1024 * 1024 }),
      media: { resolver },
    });
    expect(resolver.calls).toHaveLength(0);
    expect(q(el, '[data-media-state="too-large"]')).not.toBeNull();
    // ...and a host policy can raise it.
    const big = resolverOf(ok());
    await mount("lu-image", {
      widget: widget("Image"),
      value: ref({ size: 40 * 1024 * 1024 }),
      media: { resolver: big, policy: { maxBytes: { Image: 64 * 1024 * 1024 } } },
    });
    expect(big.calls).toHaveLength(1);
  });

  it("a resolver that observes a larger size than declared is refused too", async () => {
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: ref({ size: 10 }),
      media: { resolver: resolverOf(ok(undefined, { size: 99 * 1024 * 1024 })) },
    });
    expect(q(el, '[data-media-state="too-large"]')).not.toBeNull();
  });

  it("a value that fails the contract (bytes riding along, a locator address) is an error and never resolves", async () => {
    for (const bad of [
      ref({ data: "A".repeat(1000) }),
      ref({ address: "https://internal/x" }),
      "sha256:abc",
    ]) {
      const resolver = resolverOf(ok());
      const el = await mount("lu-image", {
        widget: widget("Image"),
        value: bad,
        media: { resolver },
      });
      expect(resolver.calls).toHaveLength(0);
      expect(q(el, '[data-state="error"]')).not.toBeNull();
      expect(html(el)).not.toContain("AAAA");
      expect(html(el)).not.toContain("internal");
    }
  });

  it("resolves nothing until a value arrives (a P2 handle hydrates on markVisible)", async () => {
    const resolver = resolverOf(ok());
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: undefined,
      media: { resolver },
    });
    expect(resolver.calls).toHaveLength(0);
    expect(q(el, '[data-state="loading"]')).not.toBeNull();
    Object.assign(el, { value: ref() });
    await settle(el);
    expect(resolver.calls).toHaveLength(1);
    expect(q(el, "img")).not.toBeNull();
  });

  it("waits to be on screen where IntersectionObserver exists", async () => {
    let fire: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    const resolver = resolverOf(ok());
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: ref(),
      media: { resolver },
    });
    expect(resolver.calls).toHaveLength(0);
    fire?.([{ isIntersecting: false }]);
    await settle(el);
    expect(resolver.calls).toHaveLength(0);
    fire?.([{ isIntersecting: true }]);
    await settle(el);
    expect(resolver.calls).toHaveLength(1);
  });

  it("a new value aborts the old resolution; a late answer for the old ref is dropped", async () => {
    let release: ((r: MediaResolution) => void) | undefined;
    const signals: AbortSignal[] = [];
    const slow: MediaResolver = (req, { signal }) => {
      signals.push(signal);
      if (req.ref.address === ADDR)
        return new Promise((res) => {
          release = res;
        });
      return Promise.resolve(ok("https://cdn.example.com/m/NEW"));
    };
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: ref(),
      media: { resolver: slow },
    });
    Object.assign(el, { value: ref({ address: "sha256:0002" }) });
    await settle(el);
    expect(signals[0]?.aborted).toBe(true);
    release?.(ok("https://cdn.example.com/m/OLD"));
    await settle(el);
    expect(q<HTMLImageElement>(el, "img")?.getAttribute("src")).toContain("/m/NEW");
  });

  it("an element load error (expired URL, 403) becomes the same unavailable state", async () => {
    const el = await mount("lu-image", {
      widget: widget("Image"),
      value: ref(),
      media: { resolver: resolverOf(ok()) },
    });
    q(el, "img")?.dispatchEvent(new Event("error"));
    await settle(el);
    expect(q(el, "img")).toBeNull();
    expect(q(el, '[data-media-state="unavailable"]')?.textContent?.trim()).toBe(
      "Media unavailable"
    );
  });
});

describe("lu-audio / lu-video / lu-file", () => {
  it("audio and video never autoplay and do not preload", async () => {
    for (const [tag, kind, type, el_] of [
      ["lu-audio", "Audio", "audio/mpeg", "audio"],
      ["lu-video", "Video", "video/mp4", "video"],
    ] as const) {
      const el = await mount(tag, {
        widget: widget(kind),
        value: ref({ mediaType: type }),
        media: { resolver: resolverOf(ok()) },
      });
      const m = q(el, el_);
      expect(m?.hasAttribute("autoplay")).toBe(false);
      expect(m?.getAttribute("preload")).toBe("none");
      expect(m?.hasAttribute("controls")).toBe(true);
      expect(html(el)).not.toContain(ADDR);
    }
  });

  it("a file is a safe download link: sanitised name, no opener, no referrer, purpose=download", async () => {
    const resolver = resolverOf(ok());
    const el = await mount("lu-file", {
      widget: widget("File"),
      value: ref({
        mediaType: "application/pdf",
        name: "../../etc/passwd\u202egnp.exe",
        size: 2048,
      }),
      media: { resolver },
    });
    const a = q<HTMLAnchorElement>(el, "a");
    expect(a?.getAttribute("href")).toBe("https://cdn.example.com/m/1?sig=x");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(a?.getAttribute("download")).not.toMatch(/[\\/\u202e]/);
    expect(resolver.calls[0]?.purpose).toBe("download");
    expect(q(el, "[data-file-meta]")?.textContent).toContain("application/pdf");
    expect(q(el, "[data-file-meta]")?.textContent).toContain("2 KiB");
    expect(html(el)).not.toContain(ADDR);
  });
});

describe("lu-media-input", () => {
  const input = (el: HTMLElement) =>
    q<HTMLInputElement>(el, 'input[type="file"]') as HTMLInputElement;
  const pick = async (el: Mounted, file: File) => {
    Object.defineProperty(input(el), "files", { value: [file], configurable: true });
    input(el).dispatchEvent(new Event("change"));
    await settle(el);
  };
  const wid = (props: Record<string, unknown> = {}) =>
    customWidget$({ kind: "MediaInput", id: "up", title: "Attach", props });
  const goodRef = {
    address: "sha256:0abc",
    mediaType: "image/png",
    size: 5,
    name: "x.png",
    origin: "host",
  };

  it("hands the file to the host, validates the ref, stamps origin=user and emits MEDIA_ATTACH", async () => {
    const actions: unknown[] = [];
    const upload = vi.fn(async () => ({ ok: true as const, ref: goodRef }));
    const el = await mount("lu-media-input", {
      widget: wid({ accept: ["image/*"], maxBytes: 100 }),
      media: { upload },
      onAction: (a: unknown) => actions.push(a),
    });
    expect(input(el).getAttribute("accept")).toBe("image/*");
    await pick(el, new File(["12345"], "x.png", { type: "image/png" }));
    expect(upload).toHaveBeenCalledTimes(1);
    const req = (upload.mock.calls[0] as unknown as [{ candidate: object; widgetId: string }])[0];
    expect(req.candidate).toEqual({ name: "x.png", mediaType: "image/png", size: 5 });
    expect(req.widgetId).toBe("up");
    expect(actions).toEqual([
      { type: "MEDIA_ATTACH", widgetId: "up", payload: { ref: { ...goodRef, origin: "user" } } },
    ]);
  });

  it.each([
    ["a type outside accept", new File(["1"], "a.pdf", { type: "application/pdf" })],
    ["a file over maxBytes", new File(["x".repeat(200)], "a.png", { type: "image/png" })],
  ])("never calls the host for %s", async (_l, file) => {
    const upload = vi.fn();
    const actions: unknown[] = [];
    const el = await mount("lu-media-input", {
      widget: wid({ accept: ["image/*"], maxBytes: 100 }),
      media: { upload },
      onAction: (a: unknown) => actions.push(a),
    });
    await pick(el, file);
    expect(upload).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
    expect(q(el, ".status[data-error]")).not.toBeNull();
  });

  it.each([
    ["a handler that fails", async () => ({ ok: false as const })],
    ["a handler that throws", async () => Promise.reject(new Error("x"))],
    [
      "a ref carrying bytes",
      async () => ({ ok: true as const, ref: { ...goodRef, data: "AAAA" } }),
    ],
    [
      "a ref whose address is a URL",
      async () => ({ ok: true as const, ref: { ...goodRef, address: "https://x/y" } }),
    ],
    [
      "a ref outside accept",
      async () => ({ ok: true as const, ref: { ...goodRef, mediaType: "application/pdf" } }),
    ],
  ])("emits no action for %s", async (_l, upload) => {
    const actions: unknown[] = [];
    const el = await mount("lu-media-input", {
      widget: wid({ accept: ["image/*"] }),
      media: { upload },
      onAction: (a: unknown) => actions.push(a),
    });
    await pick(el, new File(["1"], "x.png", { type: "image/png" }));
    expect(actions).toEqual([]);
    expect(q(el, '[data-phase="failed"]')).not.toBeNull();
  });

  it("an upload that finishes after the view changed is dropped, not stamped onto the new view", async () => {
    let finish: ((r: { ok: true; ref: object }) => void) | undefined;
    const actions: unknown[] = [];
    const el = await mount("lu-media-input", {
      widget: wid(),
      media: {
        upload: () =>
          new Promise((res) => {
            finish = res as never;
          }),
      },
      onAction: (a: unknown) => actions.push(a),
    });
    await pick(el, new File(["1"], "x.png", { type: "image/png" }));
    Object.assign(el, { widget: wid({ label: "Changed" }) });
    finish?.({ ok: true, ref: goodRef });
    await settle(el);
    expect(actions).toEqual([]);
    expect(q(el, '[data-phase="stale"]')).not.toBeNull();
  });

  it("without a host upload handler it says so and does nothing", async () => {
    const el = await mount("lu-media-input", { widget: wid() });
    await pick(el, new File(["1"], "x.png", { type: "image/png" }));
    expect(q(el, '[data-phase="unavailable"]')).not.toBeNull();
  });

  it("a bound value reaching an upload control is a contract error", async () => {
    const el = await mount("lu-media-input", { widget: wid(), value: goodRef });
    expect(q(el, '[data-state="error"]')).not.toBeNull();
  });
});
