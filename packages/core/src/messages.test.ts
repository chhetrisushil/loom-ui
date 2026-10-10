import { describe, expect, it } from "vitest";
import { chatReasonText, chatSpeaker, chatTranscriptLines } from "./chatWords";
import { describeMedia } from "./mediaText";
import { LU_MESSAGES, createSay, fill, lookupMessage, pluralForms, selectPlural } from "./messages";

describe("messages", () => {
  it("fill replaces {name} from vars, leaves unknown ones, and never recurses into a value", () => {
    expect(fill("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
    expect(fill("{a}", { a: "{b}", b: "no" })).toBe("{b}");
    expect(fill("{constructor}", {})).toBe("{constructor}");
    expect(fill("plain")).toBe("plain");
  });
  it("lookupMessage: an empty or whitespace-only translation is unset (falls through)", () => {
    expect(lookupMessage({ messages: { k: "" } }, "k", "en")).toBe("en");
    expect(lookupMessage({ messages: { k: "  " }, translate: () => "t" }, "k", "en")).toBe("t");
    expect(lookupMessage({ translate: () => "" }, "k", "en")).toBe("en");
  });
  it("lookupMessage: catalogue, then translate, then English; a throwing translate is English", () => {
    expect(lookupMessage(undefined, "k", "en")).toBe("en");
    expect(lookupMessage({ messages: { k: "m" }, translate: () => "t" }, "k", "en")).toBe("m");
    expect(lookupMessage({ translate: () => "t" }, "k", "en")).toBe("t");
    expect(lookupMessage({ translate: () => undefined }, "k", "en")).toBe("en");
    expect(
      lookupMessage(
        {
          translate: () => {
            throw new Error("x");
          },
        },
        "k",
        "en"
      )
    ).toBe("en");
    // a key inherited from Object.prototype is not a translation
    expect(lookupMessage({ messages: {} }, "toString", "en")).toBe("en");
  });
  it("selectPlural applies a locale's category only to a real translation", () => {
    const id = (_k: string, f: string) => f;
    const en = pluralForms("lu.plural.row");
    expect(selectPlural("ja-JP", "lu.plural.row", 1, en, id)).toBe("row");
    expect(selectPlural("fr", "lu.plural.row", 0, en, id)).toBe("rows");
    const fr = (k: string, f: string) => (k === "lu.plural.row.one" ? "ligne" : f);
    expect(selectPlural("fr", "lu.plural.row", 0, en, fr)).toBe("ligne");
  });
  it("the shared chat / media words speak through `say`, English by default", () => {
    const say = createSay({ messages: { "lu.chat.who.assistant": "Assistent" } });
    const entry = { id: "a", turn: 1, role: "assistant", status: "complete" } as never;
    expect(chatSpeaker(entry, {} as never)).toBe("Assistant");
    expect(chatSpeaker(entry, {} as never, say)).toBe("Assistent");
    expect(chatReasonText("denied")).toBe(LU_MESSAGES["lu.chat.reason.denied"]);
    expect(chatReasonText("not-a-token")).toBe(LU_MESSAGES["lu.chat.reason.generic"]);
    expect(
      chatReasonText("denied", createSay({ messages: { "lu.chat.reason.denied": "Nein" } }))
    ).toBe("Nein");
    expect(chatTranscriptLines({ entries: [] } as never, { say })).toEqual([]);
    const ref = { address: "a", mediaType: "image/png" } as never;
    expect(describeMedia("Image", ref)).toBe("image (image/png)");
    expect(
      describeMedia("Image", ref, createSay({ messages: { "lu.media.kind.image": "Bild" } }))
    ).toBe("Bild (image/png)");
  });
});
