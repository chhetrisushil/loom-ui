import { describe, expect, it } from "vitest";
import { oneLineChatText, sanitizeChatText } from "./chatText";
import { MAX_CHAT_TEXT } from "./chatValue";

const ESC = String.fromCharCode(27);
const RLO = String.fromCharCode(0x202e);

/** Code points no sanitised output may contain (a scan, not a regex: it asserts independently of the implementation). */
function forbidden(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (
      (c < 32 && c !== 10 && c !== 9) ||
      (c >= 0x7f && c < 0xa0) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0x200b ||
      (c >= 0xe0000 && c <= 0xe007f)
    )
      out.push(c);
  }
  return out;
}

describe("sanitizeChatText", () => {
  it("removes terminal escapes, C1 controls, bidi overrides, zero-width marks and TAG characters", () => {
    const tag = String.fromCodePoint(0xe0041, 0xe0042);
    const dirty = `a${ESC}[31mred${ESC}[0m b${RLO}c${String.fromCharCode(0x200b)}d${tag}e${String.fromCharCode(0x85)}f${String.fromCharCode(0xfeff)}g${String.fromCharCode(0x2066)}h`;
    expect(sanitizeChatText(dirty)).toBe("a[31mred[0m bcdefgh");
  });

  it("keeps what a reader needs: newlines, tabs, emoji ZWJ sequences, non-Latin scripts", () => {
    const family = "👨\u200d👩\u200d👧";
    expect(sanitizeChatText(`a\n\tb ${family} 日本語 مرحبا`)).toBe(`a\n\tb ${family} 日本語 مرحبا`);
  });

  it("normalises line breaks and collapses vertical-space bombs", () => {
    expect(sanitizeChatText("a\r\nb\rc\u2028d\u2029e")).toBe("a\nb\nc\nd\ne");
    expect(sanitizeChatText(`a${"\n".repeat(5000)}b`)).toBe("a\n\nb");
  });

  it("does not turn markup into anything: it is text, and stays text", () => {
    const html =
      "<img src=x onerror=alert(1)><script>alert(1)</script>[x](javascript:alert(1)) **b** `c`";
    expect(sanitizeChatText(html)).toBe(html); // escaping is the renderer's text node; nothing here interprets it
  });

  it("is bounded, ends the cut with an ellipsis and never splits a surrogate pair", () => {
    const out = sanitizeChatText("😀".repeat(100), 11);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff]…$/);
    expect(sanitizeChatText("x".repeat(MAX_CHAT_TEXT + 10)).length).toBe(MAX_CHAT_TEXT);
    expect(sanitizeChatText(12)).toBe("");
    expect(sanitizeChatText(undefined)).toBe("");
  });

  it("is LINEAR: 100 KB of adversarial text finishes in absolute time bounds", () => {
    const n = 100_000;
    const cases: Record<string, string> = {
      newlines: "\n".repeat(n),
      mixedBreaks: "\r\n".repeat(n / 2),
      controls: ESC.repeat(n),
      bidi: RLO.repeat(n),
      tags: String.fromCodePoint(0xe0041).repeat(n / 2),
      alternating: "a\n\n\n".repeat(n / 4),
      spaces: " ".repeat(n),
      dots: "a.".repeat(n / 2),
      surrogates: "\ud83d".repeat(n),
    };
    for (const [name, text] of Object.entries(cases)) {
      const t0 = performance.now();
      sanitizeChatText(text);
      oneLineChatText(text);
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${ms.toFixed(1)}ms`).toBeLessThan(250);
    }
    // Ten times the input costs about ten times, not a hundred (no quadratic path).
    const time = (len: number): number => {
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) sanitizeChatText("a\n\n\n \r".repeat(len));
      return performance.now() - t0;
    };
    time(1000);
    const small = Math.max(time(10_000), 0.5);
    const big = time(100_000);
    expect(big / small).toBeLessThan(40);
  });

  it("FUZZ: no output ever contains a control, bidi override or TAG character", () => {
    let seed = 0x1234abcd;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pool = [
      ESC,
      RLO,
      "\u0007",
      "\u0085",
      "\u200b",
      "\u2067",
      "\u2029",
      "<",
      ">",
      "&",
      "a",
      " ",
      "\n",
      "\t",
      "\u{e0061}",
      "😀",
      "\ud800",
      "é",
    ];
    for (let i = 0; i < 400; i++) {
      let s = "";
      for (let j = 0; j < 60; j++) s += pool[Math.floor(rnd() * pool.length)];
      const out = sanitizeChatText(s);
      expect(forbidden(out)).toEqual([]);
      expect(out).not.toContain("\r");
    }
  });
});

describe("oneLineChatText", () => {
  it("is one bounded line", () => {
    expect(oneLineChatText("a\n\n b\t c")).toBe("a b c");
    expect(oneLineChatText("x".repeat(500), 20).length).toBe(20);
  });
});

describe("invisible glyph carriers (fix round 1)", () => {
  const cp = (...c: number[]) => String.fromCodePoint(...c);
  it("strips variation selectors, the soft hyphen and Hangul fillers (a blank-looking name)", () => {
    expect(sanitizeChatText(`a${cp(0xfe00)}b${cp(0xfe0e)}c${cp(0xe0100)}d${cp(0xe01ef)}e`)).toBe(
      "abcde"
    );
    expect(
      sanitizeChatText(`x${cp(0xad)}y${cp(0x3164)}z${cp(0x115f)}${cp(0x1160)}${cp(0xffa0)}w`)
    ).toBe("xyzw");
    // a name made only of fillers becomes empty, so it cannot pass for a blank / lookalike speaker
    expect(sanitizeChatText(`${cp(0x3164)}${cp(0x115f)}${cp(0xffa0)}`)).toBe("");
  });
  it("keeps VS16 after an emoji or symbol, drops it after ASCII", () => {
    expect(sanitizeChatText(`${cp(0x2764, 0xfe0f)}`)).toBe(cp(0x2764, 0xfe0f));
    expect(sanitizeChatText(`${cp(0x1f600, 0xfe0f)}`)).toBe(cp(0x1f600, 0xfe0f));
    expect(sanitizeChatText(`a${cp(0xfe0f)}b`)).toBe("ab");
  });
  it("stays linear with 100 KB of them", () => {
    const t0 = performance.now();
    sanitizeChatText(cp(0xfe0f).repeat(100_000));
    sanitizeChatText(`a${cp(0xfe0f)}`.repeat(50_000));
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe("fix round 2: VS16 is kept only where it selects something", () => {
  const cp = (...c: number[]) => String.fromCodePoint(...c);
  const VS = cp(0xfe0f);
  it("a run collapses to ONE after an emoji (no 200 000-mark side channel) and to none after text", () => {
    expect(sanitizeChatText(`${cp(0x1f600)}${VS.repeat(200_000)}`, 1_000_000)).toBe(
      `${cp(0x1f600)}${VS}`
    );
    expect(sanitizeChatText(`a${VS}${VS}`)).toBe("a");
    expect(sanitizeChatText(`${cp(0x2764)}${VS}${VS}${VS}`)).toBe(`${cp(0x2764)}${VS}`);
  });
  it("is dropped after whitespace, a no-break space, an em space and line separators; kept after (c) and after a keycap sequence", () => {
    for (const w of [" ", "\n", "\t", cp(0xa0), cp(0x2003), cp(0x2028), cp(0x2029), cp(0x3000)])
      expect(sanitizeChatText(`x${w}${VS}y`).includes(VS), JSON.stringify(w)).toBe(false);
    expect(sanitizeChatText(`${cp(0xa9)}${VS}`)).toBe(`${cp(0xa9)}${VS}`);
    expect(sanitizeChatText(`1${VS}${cp(0x20e3)}`)).toBe(`1${VS}${cp(0x20e3)}`);
    expect(sanitizeChatText(`#${VS}${cp(0x20e3)}`)).toBe(`#${VS}${cp(0x20e3)}`);
    expect(sanitizeChatText(`1${VS}2`)).toBe("12");
    expect(sanitizeChatText(`${VS}lead`)).toBe("lead");
  });
  it("PROPERTY: sanitising its own output changes nothing (idempotent) over a random corpus", () => {
    let seed = 0xbeef;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pool = [
      VS,
      VS,
      cp(0x1f600),
      cp(0x2764),
      "a",
      "1",
      "#",
      cp(0x20e3),
      " ",
      "\n",
      cp(0xa0),
      cp(0x2028),
      cp(0x200d),
      cp(0xfe0e),
      cp(0xad),
      "\r",
      cp(0xa9),
      "é",
      cp(0xd83d),
    ];
    for (let i = 0; i < 2000; i++) {
      let s = "";
      for (let j = 0; j < 25; j++) s += pool[Math.floor(rnd() * pool.length)];
      const once = sanitizeChatText(s);
      expect(sanitizeChatText(once), JSON.stringify(s)).toBe(once);
    }
  });
});
