import { safeLinkHref } from "./chatMdTypes";

// ── Where a markdown link goes (U8c) ────────────────────────────────────────────────────────────────
// The render-time re-check every renderer applies to a link node (the parser applied `safeLinkHref` already; a node is
// never trusted): http(s) or mailto only, and a mailto names exactly ONE address, with nothing that adds recipients
// (a list, a percent-encoded `,` or `;`, a `to` / `cc` / `bcc` parameter after `?`, `&` or `;`, a second `?`, a `#`, an
// encoded `@`, any control character). The host is the URL parser's, so an
// international name is its punycode form.

export type MdDestination = { readonly href: string; readonly host: string; readonly web: boolean };

/** `host` without a leading `www.`, lower case. */
const site = (host: string): string => host.toLowerCase().replace(/^www\./, "");

/** The host a label names, when the label is nothing but an address or a bare host name. */
function labelHost(label: string): string | undefined {
  const l = label.trim();
  if (l === "" || /[\s\\@]/.test(l)) return undefined;
  try {
    if (/^https?:\/\//i.test(l)) return new URL(l).host;
    if (/^[^/?#:]+\.[^/?#:]+$/.test(l)) return new URL(`http://${l}`).host;
  } catch {
    // not an address
  }
  return undefined;
}

const MAILTO_REFUSED =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing controls is the point
  /#|\?.*\?|%40|%[01][0-9a-f]|%7f|%c2%[89][0-9a-f]|[\u0000-\u001f\u007f-\u009f]/i;

/** Where a link goes, or undefined when it is not a link a transcript may carry. */
export function mdDestination(raw: unknown): MdDestination | undefined {
  const href = typeof raw === "string" ? safeLinkHref(raw) : undefined;
  if (href === undefined) return undefined;
  try {
    if (/^mailto:/i.test(href)) {
      // nothing a lenient client could read as a second recipient or a hidden byte: no `#` (a fragment that looks like a
      // query), a second `?`, an encoded `@` or any NUL / control character, raw or percent-encoded, anywhere
      if (MAILTO_REFUSED.test(href.slice(7))) return undefined;
      const rest = href.slice(7);
      const q = rest.indexOf("?");
      const addr = q < 0 ? rest : rest.slice(0, q);
      const query = q < 0 ? "" : rest.slice(q + 1);
      const at = addr.indexOf("@");
      // one address: no list (`,` `;`, or their percent forms), one `@`, something on both sides
      if (at < 1 || at !== addr.lastIndexOf("@") || /[,;]|%2c|%3b/i.test(addr)) return undefined;
      // no parameter that adds recipients
      for (const pair of query.split(/[&;]/)) {
        const name = decodeURIComponent((pair.split("=")[0] ?? "").replace(/\+/g, " "))
          .trim()
          .toLowerCase();
        if (name === "to" || name === "cc" || name === "bcc") return undefined;
      }
      const host = new URL(`http://${addr.slice(at + 1)}`).host;
      return host === "" ? undefined : { href, host, web: false };
    }
    if (!/^https?:/i.test(href)) return undefined;
    return { href, host: new URL(href).host, web: true };
  } catch {
    return undefined; // includes a malformed percent-escape in a parameter name
  }
}

/** Does the label say the very site the link goes to? */
export function mdLabelIsSite(label: string, d: MdDestination): boolean {
  if (label.trim() === d.href) return true;
  const named = labelHost(label);
  return named !== undefined && site(named) === site(d.host);
}

/** The address as a reader should see it: an international host in its punycode form, so it cannot pass for another. */
export function mdDisplayAddress(d: MdDestination): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: tests for any non-ASCII character
  if (!/[^\u0000-\u007f]/.test(d.href)) return d.href;
  try {
    if (d.web) return new URL(d.href).href;
    const rest = d.href.slice(7);
    const at = rest.indexOf("@");
    const tail = rest.slice(at + 1).search(/[?#]/);
    const end = tail < 0 ? rest.length : at + 1 + tail;
    return `${d.href.slice(0, 7)}${rest.slice(0, at + 1)}${d.host}${rest.slice(end)}`;
  } catch {
    return d.href;
  }
}
