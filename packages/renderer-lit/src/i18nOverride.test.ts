import { LU_MESSAGES, LU_MESSAGE_KEYS } from "@loom-ui/core/messages";
import { afterEach, describe, expect, it } from "vitest";
import { describeValue, emptyStateText } from "./a11y";
import { placeholderFor } from "./dom/registry";
import { configureI18n, currentLocale, setLocale } from "./i18n";
import "./register";

// U14: the host override. With none, English (the rest of the suite proves that, byte for byte); with
// one, every fixed word a renderer prints comes from the host.

afterEach(() => {
  configureI18n(undefined);
  setLocale("en-US");
});

const mount = async <T extends HTMLElement>(
  tag: string,
  props: Record<string, unknown> = {}
): Promise<T> => {
  const el = document.createElement(tag) as T & { updateComplete: Promise<unknown> };
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};

describe("configureI18n — the host override", () => {
  it("a catalogue answers by key; everything it lacks stays English", () => {
    expect(emptyStateText()).toBe("No data");
    configureI18n({ messages: { "lu.empty.noData": "Keine Daten" } });
    expect(emptyStateText()).toBe("Keine Daten");
    expect(describeValue("Table", { columns: ["a"], rows: [] }, "T")).toBe("T: table with 0 rows");
  });
  it("a translate function sees (key, english); undefined leaves English; a throw is English", () => {
    const asked: Array<[string, string]> = [];
    configureI18n({
      translate: (key, english) => {
        asked.push([key, english]);
        if (key === "lu.empty.noData") return "Aucune donnée";
        if (key === "lu.state.error") throw new Error("broken host translator");
        return undefined;
      },
    });
    expect(emptyStateText()).toBe("Aucune donnée");
    expect(describeValue("MetricCard", "nope", "M")).toBe("M: error");
    expect(asked).toContainEqual(["lu.empty.noData", "No data"]);
  });
  it("the catalogue wins over translate; configureI18n(undefined) restores English", () => {
    configureI18n({
      messages: { "lu.empty.noData": "A" },
      translate: () => "B",
    });
    expect(emptyStateText()).toBe("A");
    configureI18n(undefined);
    expect(emptyStateText()).toBe("No data");
  });
  it("placeholders are filled, and a counted noun follows the host's plural forms", () => {
    configureI18n({
      locale: "ru",
      messages: {
        "lu.a11y.tableWith": "таблица из {rows} {noun}",
        "lu.plural.row.one": "строка",
        "lu.plural.row.few": "строки",
        "lu.plural.row.many": "строк",
      },
    });
    expect(currentLocale()).toBe("ru");
    const rows = (n: number) => ({ columns: ["a"], rows: Array.from({ length: n }, () => ["x"]) });
    expect(describeValue("Table", rows(1), "T")).toBe("T: таблица из 1 строка");
    expect(describeValue("Table", rows(3), "T")).toBe("T: таблица из 3 строки");
    expect(describeValue("Table", rows(5), "T")).toBe("T: таблица из 5 строк");
  });
  it("a placeholder in a host's text that has no value is left as written, not 'undefined'", () => {
    configureI18n({ messages: { "lu.dom.noRenderer": "kein Renderer für {kind} ({missing})" } });
    expect(placeholderFor("X", "missing").textContent).toBe("kein Renderer für X ({missing})");
  });
  it("a mounted element re-renders when the override changes", async () => {
    const el = await mount<HTMLElement>("lu-locale-picker", { locales: ["en-US", "de-DE"] });
    const select = () => el.shadowRoot?.querySelector("select") as HTMLSelectElement;
    expect(select().getAttribute("aria-label")).toBe("Language");
    configureI18n({ messages: { "lu.locale.language": "Sprache" } });
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(select().getAttribute("aria-label")).toBe("Sprache");
    expect(select().title).toBe("Sprache");
    el.remove();
  });
  it("widgets draw the host's words: chat empty state, time-range label", async () => {
    configureI18n({
      messages: { "lu.range.title": "Zeitraum", "lu.range.custom": "Benutzerdefiniert" },
    });
    const el = await mount<HTMLElement>("lu-time-range-picker");
    expect(el.shadowRoot?.textContent).toContain("Benutzerdefiniert");
    expect(el.shadowRoot?.querySelector(".icon")?.getAttribute("title")).toBe("Zeitraum");
    el.remove();
  });
  it("the host can see every key it may translate", () => {
    expect(LU_MESSAGE_KEYS.length).toBe(Object.keys(LU_MESSAGES).length);
    expect(LU_MESSAGE_KEYS).toContain("lu.empty.noData");
  });
});
