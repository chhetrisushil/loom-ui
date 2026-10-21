import { describe, expect, it } from "vitest";
import { mdDestination } from "./chatMdDest";

describe("mdDestination", () => {
  it("accepts http, https and a one-address mailto", () => {
    expect(mdDestination("https://e.example/a")?.host).toBe("e.example");
    expect(mdDestination("mailto:a@b.example?subject=hi")?.web).toBe(false);
    expect(mdDestination("javascript:alert(1)")).toBeUndefined();
    expect(mdDestination(5)).toBeUndefined();
  });
  it("refuses a mailto naming more than one recipient", () => {
    for (const bad of [
      "mailto:a@x.example,b@y.example",
      "mailto:a@x.example;b@y.example",
      "mailto:a%2Cb@y.example",
      "mailto:a%2cb@y.example",
      "mailto:a%3Bb@y.example",
      "mailto:a%3bb@y.example",
      "mailto:a@x.example?cc=b@y.example",
      "mailto:a@x.example?subject=s&BCC=b@y.example",
      "mailto:a@x.example?x=1&to=b@y.example",
      "mailto:a@x.example?%63c=b@y.example",
      "mailto:a@x.example?%zz=1",
    ])
      expect(mdDestination(bad), bad).toBeUndefined();
  });
  it("keeps a mailto whose parameters only mention those words in a value", () => {
    expect(mdDestination("mailto:a@x.example?subject=cc&body=bcc")).toBeDefined();
  });
});
