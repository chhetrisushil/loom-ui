import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LU_MESSAGES, LU_MESSAGE_KEYS } from "./messages";

// U14 fitness: no fixed, user-visible English string is written inline in a renderer source. Every one
// is a key in the catalogue (`messages.ts`), so a host that translates the catalogue translates all of
// it. This is a test file, not a module, because it needs `typescript` (a dev dependency that must not
// ship in `dist`).
//
// The scanner behind `i18nFitness.test.ts`: finds fixed, user-visible English a renderer source
// writes inline instead of asking the catalogue for it. A pragmatic AST check, not a proof — it covers
// the ways a renderer puts words in front of a reader:
//   1. the static text and the text-bearing attributes of an `html` template (Lit);
//   2. text assigned or set on an element: `.textContent =`, `.title =`, `.placeholder =`,
//      `.setAttribute("aria-label" | "title" | "placeholder" | "alt", …)`;
//   2c. a capitalised single word returned from a function (`return "Loading"`).
//   3. any other string that reads as prose (two or more words) outside the places that are not
//      shown to a reader: imports, comparisons, `throw`/`Error`/`console`, CSS, type literals,
//      property names, selectors.
// KNOWN LIMIT: a single-word literal is caught only in the positions above (a `??`/`||` fallback, a
// text-bearing property, an element text/attribute setter, a returned capitalised word). A bare
// lower-case word (`const s = "loading"`) or one passed through a variable is NOT caught: a general
// single-word rule would flag every enum value, event name and CSS keyword. Reviewers cover the rest.
// A hit means: add the text to `LU_MESSAGES` and ask for it by key.

interface Hit {
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

const TEXT_ATTRS = ["aria-label", "title", "placeholder", "alt", "aria-description", "label"];
const SET_ATTRS = new Set([...TEXT_ATTRS, "aria-roledescription", "aria-valuetext"]);
const TEXT_PROPS = new Set(["textContent", "innerText", "title", "placeholder", "ariaLabel"]);
const TEXT_KEYS = new Set([
  "label",
  "title",
  "text",
  "placeholder",
  "caption",
  "hint",
  "tooltip",
  "message",
  "headline",
  "detail",
  "summary",
  "ariaLabel",
]);
// A CSS value / colour / unit is not prose.
const CSS_LIKE = /var\(|rgba?\(|\d\s*px|#[0-9a-f]{3,8}\b|^\d/i;
/** Stands for a `${…}` hole in a template when its static text is read on its own. */
const HOLE = "\u0000";
const PROSE = /[A-Za-z]{2,}[ ]+[A-Za-z]{2,}/;
/** A single capitalised word, as an English label would be (`Loading`), not an identifier-ish token. */
const CAPITAL_WORD = /^[A-Z][a-z]{2,}$/;
const HAS_WORD = /[A-Za-z]{2,}/;
// Console / diagnostics callees whose arguments are for the developer.
const DEV_CALLEES = /^(console|Error|TypeError|RangeError|assert|expect)\b/;

function calleeText(n: ts.Node): string {
  return ts.isCallExpression(n) || ts.isNewExpression(n) ? n.expression.getText() : "";
}

/** Static text of a `html` template, as a reader would meet it: tags dropped, text-bearing attributes kept. */
function htmlTemplateWords(strings: string): string[] {
  const noStyle = strings.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const out: string[] = [];
  for (const m of noStyle.matchAll(/\b([a-z-]+)="([^"]*)"/g)) {
    const [, name, value] = m;
    if (TEXT_ATTRS.includes(name as string) && !/\$\{/.test(value as string)) {
      // a value that is only a placeholder (the template holes are removed first) carries no literal text
      if (HAS_WORD.test(value as string)) out.push(value as string);
    }
  }
  const text = noStyle
    .replace(/<[^>]*>/g, " ") // tags (and their attributes)
    .replace(/&[a-z]+;/g, " ")
    .trim();
  if (HAS_WORD.test(text)) out.push(text);
  return out;
}

function findHardcodedEnglish(source: string, fileName = "x.ts"): Hit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const add = (n: ts.Node, text: string, why: string): void => {
    hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text, why });
  };

  const skippedParent = (n: ts.Node): boolean => {
    const p = n.parent;
    if (p === undefined) return false;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p))
      return true;
    if (ts.isPropertyAssignment(p) && p.name === n) return true; // a key
    if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true;
    if (ts.isCaseClause(p) && p.expression === n) return true;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (
        k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        k === ts.SyntaxKind.EqualsEqualsToken ||
        k === ts.SyntaxKind.ExclamationEqualsToken
      )
        return true;
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const callee = calleeText(p);
      if (DEV_CALLEES.test(callee)) return true;
      // Names, selectors, event types and token lists are not shown to a reader.
      if (
        /(^|\.)(setAttribute|removeAttribute|getAttribute|querySelector|querySelectorAll|createElement|addEventListener|removeEventListener|customElements\.get|customElements\.define|hasAttribute|closest|matches|customElement|requestAnimationFrame|has|get|set|add|delete|includes|startsWith|endsWith|test|register|safeParse|parse|dispatchEvent|CustomEvent|Event|RegExp|Intl\.\w+|NumberFormat|DateTimeFormat|PluralRules|DisplayNames|createHash|update|digest|property|state|createContext|String\.raw|JSON\.parse|encodeURIComponent|decodeURIComponent|import|require|localStorage\.\w+)$/.test(
          callee
        ) &&
        p.arguments?.[0] === n
      )
        return true;
    }
    if (ts.isThrowStatement(p)) return true;
    return false;
  };

  const inCssTag = (n: ts.Node): boolean => {
    for (let a: ts.Node | undefined = n; a; a = a.parent)
      if (ts.isTaggedTemplateExpression(a) && /^(css|unsafeCSS|svg)$/.test(a.tag.getText()))
        return true;
    return false;
  };

  const visit = (n: ts.Node): void => {
    // 1. html`...`
    if (ts.isTaggedTemplateExpression(n) && n.tag.getText() === "html") {
      const t = n.template;
      const parts = ts.isNoSubstitutionTemplateLiteral(t)
        ? [t.text]
        : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)];
      // holes become a neutral marker so `<b>${x}</b>` is not read as text
      for (const w of htmlTemplateWords(parts.join(HOLE))) {
        const clean = w.split(HOLE).join(" ").trim();
        if (HAS_WORD.test(clean)) add(n, clean, "html template text");
      }
    }
    // 2. element text / attribute setters
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      TEXT_PROPS.has(n.left.name.text) &&
      !n.left.expression.getText().endsWith("dataset")
    ) {
      const r = n.right;
      if ((ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r)) && HAS_WORD.test(r.text))
        add(n, r.text, `.${n.left.name.text} assignment`);
      if (
        ts.isTemplateExpression(r) &&
        HAS_WORD.test(r.head.text + r.templateSpans.map((s) => s.literal.text).join(""))
      )
        add(n, r.getText(), `.${n.left.name.text} assignment`);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "setAttribute"
    ) {
      const [a, b] = n.arguments;
      if (
        a !== undefined &&
        ts.isStringLiteral(a) &&
        SET_ATTRS.has(a.text) &&
        b !== undefined &&
        (ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b)) &&
        HAS_WORD.test(b.text)
      )
        add(n, b.text, `setAttribute(${a.text})`);
    }
    // 2b. a single-word fallback (`x ?? "Approve"`) or a text-bearing property (`label: "Close"`)
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      (ts.isStringLiteral(n.right) || ts.isNoSubstitutionTemplateLiteral(n.right)) &&
      HAS_WORD.test(n.right.text) &&
      !CSS_LIKE.test(n.right.text)
    )
      add(n.right, n.right.text, "fallback literal");
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      TEXT_KEYS.has(n.name.text) &&
      (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)) &&
      HAS_WORD.test(n.initializer.text)
    )
      add(n.initializer, n.initializer.text, `${n.name.text}: literal`);
    // 2c. a capitalised single word returned (or an arrow's expression body): `return "Loading"`
    if (
      ((ts.isReturnStatement(n) && n.expression !== undefined) ||
        (ts.isArrowFunction(n) && !ts.isBlock(n.body))) &&
      (() => {
        const e = ts.isReturnStatement(n) ? n.expression : (n as ts.ArrowFunction).body;
        return (
          e !== undefined &&
          (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) &&
          CAPITAL_WORD.test(e.text)
        );
      })()
    ) {
      const e = ts.isReturnStatement(n) ? n.expression : (n as ts.ArrowFunction).body;
      add(e as ts.Node, (e as ts.StringLiteral).text, "returned word");
    }
    // 3. prose anywhere
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      !skippedParent(n) &&
      !inCssTag(n) &&
      PROSE.test(n.text) &&
      !CSS_LIKE.test(n.text) &&
      !(ts.isTaggedTemplateExpression(n.parent) && n.parent.template === n)
    ) {
      add(n, n.text, "prose literal");
    }
    if (ts.isTemplateExpression(n) && !inCssTag(n) && !ts.isTaggedTemplateExpression(n.parent)) {
      const literalText = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(HOLE);
      if (
        PROSE.test(literalText.split(HOLE).join(" ")) &&
        !(
          n.parent &&
          (ts.isThrowStatement(n.parent) ||
            (ts.isCallExpression(n.parent) && DEV_CALLEES.test(calleeText(n.parent))))
        )
      )
        add(n, n.getText(), "prose template");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // De-duplicate (an html template reports once per text, a literal inside it may report again).
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.line}|${h.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── What is scanned ──────────────────────────────────────────────────────────────────────────────

const PACKAGES = resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", "dist"]);
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.ts$/.test(name) && !/\.test(-support)?\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const SCANNED = [
  ...sources(join(PACKAGES, "renderer-lit/src")),
  ...sources(join(PACKAGES, "renderer-terminal/src")),
  // The words both renderers share live in core.
  join(PACKAGES, "core/src/chatWords.ts"),
  join(PACKAGES, "core/src/mediaText.ts"),
];

/**
 * The text that is NOT a user-visible fixed word, each with the reason. `file` is relative to
 * `packages/`; `text` must EQUAL the hit's text exactly (no substring match). A stale entry (matching nothing) fails below.
 */
type Allowance = { file: string; why: string } & (
  | { text: string; textStart?: undefined }
  | { textStart: string; text?: undefined }
);
const ALLOWED: ReadonlyArray<Allowance> = [
  {
    file: "renderer-lit/src/dom/renderBlueprintDom.ts",
    text: "heading",
    why: "an ARIA role name, not drawn text",
  },
  {
    file: "renderer-lit/src/dom/renderBlueprintDom.ts",
    text: "re-entrant update",
    why: "a developer refusal reason on a returned result, never drawn",
  },
  {
    file: "renderer-lit/src/dom/renderBlueprintDom.ts",
    text: "`malformed node at ${path}`",
    why: "a developer finding delivered to onFail / RecomposeReport, never drawn",
  },
  {
    file: "renderer-lit/src/dom/renderBlueprintDom.ts",
    text: "renderBlueprintDom: dispose failed for one or more widgets",
    why: "a developer error thrown to the host",
  },
  {
    file: "renderer-lit/src/dom/tree.ts",
    text: '`no renderer for "${widget.kind}"`',
    why: "a developer finding delivered to onFail / RecomposeReport, never drawn",
  },
  {
    file: "renderer-lit/src/dom/tree.ts",
    text: '`container renderer for role "${role}" at ${path} failed: ${e instanceof Error ? e.message : String(e)}`',
    why: "a developer finding delivered to onFail / RecomposeReport, never drawn",
  },
  { file: "renderer-lit/src/rtl.ts", text: "mirror", why: "a direction-mode keyword, not text" },
  {
    file: "renderer-lit/src/sandbox/protocol.ts",
    textStart: "`<!doctype html>",
    why: "the sandbox frame's HTML document, not renderer chrome",
  },
  {
    file: "renderer-lit/src/widgets/lu-chat.ts",
    text: "File",
    why: "a media KIND token, translated where it is drawn (lu.media.kind.*)",
  },
  {
    file: "core/src/chatWords.ts",
    text: "File",
    why: "a media KIND token, translated where it is drawn (lu.media.kind.*)",
  },
];

/**
 * An allowance silences ONE known hit: same file and the hit's text EQUAL to `text`. Only a whole
 * multi-line markup template (the sandbox frame, a tooltip) is matched by its full literal opening
 * (`textStart`), because its body is long and incidental; a new literal never starts that way.
 */
function matches(a: Allowance, h: { file: string; text: string }): boolean {
  if (a.file !== h.file) return false;
  return a.text !== undefined ? h.text === a.text : h.text.startsWith(a.textStart);
}

describe("renderer sources carry no inline user-visible English (U14)", () => {
  it("scans a real, non-trivial set of sources", () => {
    expect(SCANNED.length).toBeGreaterThan(40);
    expect(SCANNED.some((f) => f.endsWith("lu-chat.ts"))).toBe(true);
    expect(SCANNED.some((f) => f.endsWith("renderer-terminal/src/registry.ts"))).toBe(true);
  });

  const found = SCANNED.flatMap((f) =>
    findHardcodedEnglish(readFileSync(f, "utf8"), f).map((h) => ({
      file: relative(PACKAGES, f),
      ...h,
    }))
  );
  const unallowed = found.filter((h) => !ALLOWED.some((a) => matches(a, h)));

  it("every fixed word is a catalogue key (add the text to LU_MESSAGES and ask for it by key)", () => {
    expect(
      unallowed.map((h) => `${h.file}:${h.line} [${h.why}] ${JSON.stringify(h.text)}`)
    ).toEqual([]);
  });

  it("every allowance still matches something (no stale entries)", () => {
    for (const a of ALLOWED)
      expect(
        found.some((h) => matches(a, h)),
        `${a.file}: ${a.text}`
      ).toBe(true);
  });
});

describe("the scanner is not vacuous: it fails on an injected literal in every context it covers", () => {
  const hits = (src: string) => findHardcodedEnglish(src).map((h) => h.why);
  it("an html template's text", () => {
    expect(hits("const a = html`<p>Nothing to show</p>`;")).toContain("html template text");
  });
  it("an html template's text-bearing attribute", () => {
    expect(hits('const a = html`<button aria-label="Close">x</button>`;')).toContain(
      "html template text"
    );
    expect(hits('const a = html`<input placeholder="Search">`;')).toContain("html template text");
  });
  it("textContent / title assignment and setAttribute", () => {
    expect(hits('el.textContent = "Back";')).toContain(".textContent assignment");
    expect(hits("el.textContent = `Step ${n}`;")).toContain(".textContent assignment");
    expect(hits('el.setAttribute("aria-label", "Steps");')).toContain("setAttribute(aria-label)");
  });
  it("a single-word fallback and a text-bearing property", () => {
    expect(hits('const l = props.label ?? "Approve";')).toContain("fallback literal");
    expect(hits('const o = { label: "Close" };')).toContain("label: literal");
  });
  it("a returned capitalised single word", () => {
    expect(hits('function f() { return "Loading"; }')).toContain("returned word");
    expect(hits('const f = () => "Loading";')).toContain("returned word");
    expect(hits('function f() { return "loading-state"; }')).toEqual([]);
  });
  it("prose anywhere", () => {
    expect(hits('return "Media unavailable right now";')).toContain("prose literal");
    expect(hits("return `Showing ${n} of ${m} rows`;")).toContain("prose template");
  });
  it("does NOT flag what a reader never sees", () => {
    for (const ok of [
      'import { x } from "some module name";',
      'if (state === "not loaded yet") return;',
      'throw new Error("this is a developer error");',
      'console.warn("a developer warning here");',
      "const s = css`a { color: red; content: 'two words'; }`;",
      'el.setAttribute("data-state", "ready");',
      'const v = say("lu.empty.noData");',
      'el.style.border = "1px solid var(--lu-border, #30363d)";',
      'const html2 = html`<div class="a b" data-x="y">${say("lu.empty.noData")}</div>`;',
      'el.dataset.placeholder = "projection";',
    ])
      expect(findHardcodedEnglish(ok)).toEqual([]);
  });
});

describe("the catalogue", () => {
  const sourceText = SCANNED.filter((f) => !f.endsWith("messages.ts"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  // Families asked for by a computed key: `say(`lu.chat.reason.${reason}`)`.
  const DYNAMIC = ["lu.chat.reason.", "lu.media.kind."];

  it("keys are stable, namespaced and lower-case", () => {
    for (const k of LU_MESSAGE_KEYS) expect(k).toMatch(/^lu\.[a-z0-9]+(\.[A-Za-z0-9-]+)+$/);
    expect([...LU_MESSAGE_KEYS]).toEqual(Object.keys(LU_MESSAGES).sort());
  });
  it("every text is non-empty English", () => {
    for (const [k, v] of Object.entries(LU_MESSAGES)) expect(v.trim(), k).not.toBe("");
  });
  it("every key is used by a renderer (a dead key is a string a host translates for nothing)", () => {
    const dead = LU_MESSAGE_KEYS.filter((k) => {
      if (sourceText.includes(`"${k}"`)) return false;
      const family = DYNAMIC.find((d) => k.startsWith(d));
      if (family !== undefined && sourceText.includes(`${family}\${`)) return false;
      // a counted noun is asked by its base: `lu.plural.row` for `.one` / `.other`
      const base = k.replace(/\.(one|other)$/, "");
      return !(base !== k && sourceText.includes(`"${base}"`));
    });
    expect(dead).toEqual([]);
  });
});

describe("the READMEs list the keys a host may translate", () => {
  const listed = (pkg: string): Set<string> =>
    new Set(
      [
        ...readFileSync(join(PACKAGES, pkg, "README.md"), "utf8").matchAll(
          /^\| `(lu\.[^`]+)` \|/gm
        ),
      ].map((m) => m[1] as string)
    );
  it("renderer-lit lists every key except the terminal-only ones, and nothing that is not a key", () => {
    const lit = listed("renderer-lit");
    for (const k of LU_MESSAGE_KEYS)
      if (!k.startsWith("lu.terminal.")) expect(lit.has(k), k).toBe(true);
    for (const k of lit) expect(Object.hasOwn(LU_MESSAGES, k), k).toBe(true);
  });
  it("renderer-terminal lists every lu.terminal.* key, and nothing that is not a key", () => {
    const term = listed("renderer-terminal");
    for (const k of LU_MESSAGE_KEYS)
      if (k.startsWith("lu.terminal.")) expect(term.has(k), k).toBe(true);
    for (const k of term) expect(Object.hasOwn(LU_MESSAGES, k), k).toBe(true);
  });
});
