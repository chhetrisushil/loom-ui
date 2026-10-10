import { LU_MESSAGE_KEYS } from "@loom-ui/core";
import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_LOCALE, createLoomUiTerminalRegistry } from "./registry";

// U14: the terminal's words and locale come from the host, English / en-US by default.

const b = { projectionId: "p", path: "v" };
const w = (kind: string, props: Record<string, unknown> = {}) =>
  customWidget$({ kind, title: "T", binding: b, ...props });
const table = { columns: ["n"], rows: Array.from({ length: 25 }, (_, i) => [i]) };

describe("terminal i18n", () => {
  it("defaults to en-US and English: the same bytes as before the override existed", () => {
    expect(DEFAULT_TERMINAL_LOCALE).toBe("en-US");
    const r = createLoomUiTerminalRegistry().get("Table");
    expect(r?.(w("Table"), table)?.split("\n").at(-1)).toBe("    … 5 more rows");
  });
  it("a catalogue replaces the fixed words, with placeholders and the host's plural forms", () => {
    const r = createLoomUiTerminalRegistry({
      i18n: {
        locale: "ru",
        messages: {
          "lu.terminal.table.moreRows": "… ещё {n} {noun}",
          "lu.plural.row.one": "строка",
          "lu.plural.row.few": "строки",
          "lu.plural.row.many": "строк",
        },
      },
    }).get("Table");
    const rows = (n: number) => ({
      columns: ["n"],
      rows: Array.from({ length: 20 + n }, (_, i) => [i]),
    });
    expect(r?.(w("Table"), rows(1))?.split("\n").at(-1)).toBe("    … ещё 1 строка");
    expect(r?.(w("Table"), rows(3))?.split("\n").at(-1)).toBe("    … ещё 3 строки");
    expect(r?.(w("Table"), rows(5))?.split("\n").at(-1)).toBe("    … ещё 5 строк");
  });
  it("a locale alone changes number formatting; without a translation the words stay English", () => {
    const kpi = (locale: string | undefined) =>
      createLoomUiTerminalRegistry(locale === undefined ? {} : { i18n: { locale } }).get("Kpi")?.(
        w("Kpi"),
        { value: 1234567.5 }
      );
    expect(kpi(undefined)).toBe("T: 1,234,567.5");
    expect(kpi("de-DE")).toBe("T: 1.234.567,5");
    const r = createLoomUiTerminalRegistry({ i18n: { locale: "ja-JP" } }).get("Table");
    // Japanese has only `other`; with no translation the English text stays grammatical.
    const one = { columns: ["n"], rows: Array.from({ length: 21 }, (_, i) => [i]) };
    expect(r?.(w("Table"), one)?.split("\n").at(-1)).toBe("    … 1 more row");
  });
  it("a translate function covers markers, prompts and the chat transcript; a throw is English", () => {
    const tr = (k: string, en: string) => {
      if (k === "lu.terminal.chat.empty") return "(keine Nachrichten)";
      if (k === "lu.chat.who.assistant") return "Assistent";
      if (k === "lu.terminal.textInput") throw new Error("host bug");
      return `«${en}»`;
    };
    const reg = createLoomUiTerminalRegistry({ i18n: { translate: tr } });
    expect(reg.get("Chat")?.(w("Chat"), { entries: [] })).toContain("(keine Nachrichten)");
    expect(reg.get("A2UIView")?.(w("A2UIView"), {})).toBe("T: «[A2UI view — rendered on the web]»");
    expect(reg.get("TextInput")?.(w("TextInput", { props: { label: "Q" } }), undefined)).toContain(
      "[text input — answer on an interactive surface]"
    );
    const chat = reg.get("Chat")?.(w("Chat"), {
      entries: [
        {
          id: "a",
          turn: 1,
          role: "assistant",
          status: "complete",
          parts: [{ type: "text", text: "hi" }],
        },
      ],
    });
    expect(chat).toContain("Assistent: hi");
  });
  it("every key a terminal renderer asks for is one the host can see", () => {
    const asked = new Set<string>();
    const reg = createLoomUiTerminalRegistry({
      i18n: {
        translate: (k) => {
          asked.add(k);
          return undefined;
        },
      },
    });
    reg.get("Table")?.(w("Table"), table);
    for (const k of asked) expect(LU_MESSAGE_KEYS).toContain(k);
    expect(asked.size).toBeGreaterThan(0);
  });
});
