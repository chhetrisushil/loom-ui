import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import { type CssomStyle, cssomStyle } from "./cssomStyle";

function draw(host: HTMLElement, style: CssomStyle): HTMLElement {
  render(html`<div ${cssomStyle(style)}></div>`, host);
  return host.firstElementChild as HTMLElement;
}

describe("cssomStyle", () => {
  it("sets properties, drops one on re-render, and clears everything on {}", () => {
    const host = document.createElement("div");
    const el = draw(host, { height: "10px", "background-color": "red" });
    expect(el.style.height).toBe("10px");
    expect(el.style.backgroundColor).toBe("red");
    expect(draw(host, { height: "20px" })).toBe(el); // same element, updated in place
    expect(el.style.height).toBe("20px");
    expect(el.style.backgroundColor).toBe("");
    draw(host, {});
    expect(el.style.height).toBe("");
    expect(el.style.length).toBe(0);
  });

  it("skips undefined, null and empty values (and removes them if previously set)", () => {
    const host = document.createElement("div");
    const el = draw(host, { height: "10px", width: undefined, color: null, margin: "" });
    expect(el.style.height).toBe("10px");
    expect(el.style.length).toBe(1);
    draw(host, { height: undefined });
    expect(el.style.length).toBe(0);
  });

  it("sets and removes custom properties, and stringifies numbers", () => {
    const host = document.createElement("div");
    const el = draw(host, { "--x": "5px", "--n": 3 });
    expect(el.style.getPropertyValue("--x")).toBe("5px");
    expect(el.style.getPropertyValue("--n")).toBe("3");
    draw(host, { "--n": 4 });
    expect(el.style.getPropertyValue("--x")).toBe("");
    expect(el.style.getPropertyValue("--n")).toBe("4");
    draw(host, {});
    expect(el.style.getPropertyValue("--n")).toBe("");
  });

  it("is only valid as an element binding", () => {
    const host = document.createElement("div");
    expect(() => render(html`<div class=${cssomStyle({})}></div>`, host)).toThrow();
  });
});
