#!/usr/bin/env node
// Writes the npm publish metadata into every PUBLIC package under packages/* (a package with
// `"private": true` is never published and is left alone). One source of truth for: the shared
// release `version`, `license`, `repository` (with the package's `directory`), the `files` allowlist
// (built output + sources for the sourcemaps, never tests, test support, fixtures, tsconfig or build
// caches), `publishConfig` (public access, the `next` dist-tag), `engines`, `workspace:^` for every
// sibling dependency (pnpm publish rewrites it to `^<version>`), and a real `@loomwork/*` range in
// place of `*` (the root `pnpm.overrides` `link:` entries redirect it to ../loom for local dev and
// are never published, so the range is what a consumer installs).
//
//   node scripts/publish-metadata.mjs          # apply
//   node scripts/publish-metadata.mjs --check  # exit 1 if any package.json drifted
//   node scripts/publish-metadata.mjs --check --root <dir>   # check another tree (the guard's fault test)
//
// The guard `packages/core/src/publishMetadata.test.ts` runs `--check`, and also refuses a public
// package that depends on a private one (it could never install).
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The release version every public package carries. Bump here, re-run, commit. */
export const RELEASE_VERSION = "0.1.2";
export const DIST_TAG = "next";
export const REPOSITORY_URL = "git+https://github.com/chhetrisushil/loom-ui.git";
/** The published loom release these packages are built against. */
export const LOOM_RANGE = "^0.1.0";

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

/** Never published from `src/`: tests, test support and their data. */
const SRC_EXCLUDES = [
  "!src/**/*.test.ts",
  "!src/**/*.test.tsx",
  "!src/**/*.test-support.ts",
  "!src/**/__tests__",
  "!src/**/__fixtures__",
  "!src/**/__snapshots__",
  "!src/**/__golden__",
];

/** A file at a package's root that ships: subpath stubs (`x.js` + `.d.ts`). README ships anyway. */
function isShippedRootFile(name) {
  if (name === "README.md" || name === "package.json") return false;
  if (name.startsWith("tsconfig") || name.startsWith("vitest.config")) return false;
  return /\.(js|cjs|mjs|d\.ts)$/.test(name);
}

/** The `files` allowlist for the package at `dir`. */
export function filesFor(dir) {
  const roots = readdirSync(dir).filter(isShippedRootFile).sort();
  return ["dist", "src", ...roots, ...SRC_EXCLUDES, "LICENSE", "NOTICE"];
}

function rewriteSpecifiers(deps) {
  const out = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (spec.startsWith("workspace:")) out[name] = "workspace:^";
    // a loom package (@loomwork/*, never this repo's own @loomwork/ui-*, which are workspace:)
    else if (name.startsWith("@loomwork/")) out[name] = LOOM_RANGE;
    else out[name] = spec;
  }
  return out;
}

/** The package.json the generator would write for one public package (key order preserved). */
export function expectedPackageJson({ dir, rel, pkg }) {
  const next = { ...pkg };
  next.version = RELEASE_VERSION;
  next.license = "Apache-2.0";
  next.repository = { type: "git", url: REPOSITORY_URL, directory: rel };
  next.files = filesFor(dir);
  next.publishConfig = { access: "public", tag: DIST_TAG };
  next.engines = { node: ">=20.0.0" };
  for (const field of DEP_FIELDS) if (next[field]) next[field] = rewriteSpecifiers(next[field]);
  return next;
}

/** Every package under `<root>/packages/*`. */
export function workspacePackages(root) {
  const base = join(root, "packages");
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, "package.json")))
    .map((d) => {
      const dir = join(base, d.name);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { dir, rel: `packages/${d.name}`, pkg };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** One entry per public package, plus `errors` for a public package depending on a private sibling. */
export function plan(root) {
  const pkgs = workspacePackages(root);
  const privateNames = new Set(pkgs.filter((p) => p.pkg.private).map((p) => p.pkg.name));
  const entries = [];
  const errors = [];
  for (const p of pkgs) {
    if (p.pkg.private) continue;
    const next = expectedPackageJson(p);
    const state = JSON.stringify(next) === JSON.stringify(p.pkg) ? "ok" : "stale";
    entries.push({ rel: p.rel, file: join(p.dir, "package.json"), state, next });
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(p.pkg[field] ?? {})) {
        if (privateNames.has(dep))
          errors.push(`${p.rel}: public package depends on private ${dep}`);
      }
    }
  }
  return { entries, errors };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootArg = process.argv.indexOf("--root");
  const root =
    rootArg > 0
      ? resolve(process.argv[rootArg + 1])
      : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  const { entries, errors } = plan(root);
  for (const e of errors) console.error(e);
  const stale = entries.filter((e) => e.state === "stale");
  if (check) {
    for (const e of stale) console.error(`${e.rel}: publish metadata is stale`);
    if (stale.length) console.error("run: node scripts/publish-metadata.mjs");
    process.exit(stale.length || errors.length ? 1 : 0);
  }
  for (const e of stale) {
    writeFileSync(e.file, `${JSON.stringify(e.next, null, 2)}\n`);
    console.log(`updated ${e.rel}`);
  }
  console.log(`${entries.length} public packages, ${stale.length} updated`);
  process.exit(errors.length ? 1 : 0);
}
