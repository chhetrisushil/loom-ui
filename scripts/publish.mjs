#!/usr/bin/env node
// Publishes every public @loomwork/ui-* package to npm under the `next` dist-tag. A DRY RUN unless
// `--yes` is passed. It refuses to run on a dirty tree, stale publish metadata or an unbuilt
// package, and it audits each tarball's file list (no tests, test support, fixtures, tsconfig,
// vitest config or build caches) before handing over to `pnpm -r publish`, which rewrites
// `workspace:^` and `catalog:` into real ranges.
//
//   node scripts/publish.mjs          # checks + audit + `pnpm publish --dry-run`
//   node scripts/publish.mjs --yes    # the same, then publishes for real (needs `npm login`)
//
// The `@loomwork/*` ranges name the published loom release (LOOM_RANGE in publish-metadata.mjs), so
// loom must be published first.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIST_TAG, plan } from "./publish-metadata.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const real = process.argv.includes("--yes");

/** A path inside a tarball that must never ship. */
const FORBIDDEN = [
  /\.test\.tsx?$/,
  /\.test-support\.ts$/,
  /\.test\.(js|d\.ts)(\.map)?$/,
  /(^|\/)__(tests|fixtures|snapshots|golden)__\//,
  /(^|\/)tsconfig[^/]*\.json$/,
  /\.tsbuildinfo$/,
  /(^|\/)vitest\.config\./,
  /(^|\/)node_modules\//,
];

function fail(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

if (execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim())
  fail("the working tree is dirty; commit or stash first");

const { entries, errors } = plan(ROOT);
const stale = entries.filter((e) => e.state === "stale");
if (errors.length || stale.length)
  fail(
    [
      ...errors,
      ...stale.map((e) => `${e.rel}: stale`),
      "run: node scripts/publish-metadata.mjs",
    ].join("\n")
  );

for (const e of entries) {
  const main = e.next.main ?? "./dist/index.js";
  if (!existsSync(join(ROOT, e.rel, main))) fail(`${e.rel} is not built (${main}); run pnpm build`);
}

// LICENSE and NOTICE live at the root; each tarball carries a copy (git-ignored in packages/*).
const copied = [];
try {
  for (const e of entries) {
    for (const f of ["LICENSE", "NOTICE"]) {
      const to = join(ROOT, e.rel, f);
      copyFileSync(join(ROOT, f), to);
      copied.push(to);
    }
  }

  const bad = [];
  for (const e of entries) {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: join(ROOT, e.rel),
      encoding: "utf8",
    });
    const files = JSON.parse(out)[0].files.map((f) => f.path);
    for (const f of files) if (FORBIDDEN.some((re) => re.test(f))) bad.push(`${e.next.name}: ${f}`);
    for (const need of ["package.json", "README.md", "LICENSE", "NOTICE"])
      if (!files.includes(need)) bad.push(`${e.next.name}: missing ${need}`);
    console.log(`${e.next.name}@${e.next.version}: ${files.length} files`);
  }
  if (bad.length) fail(`tarball audit failed:\n${bad.join("\n")}`);

  const args = ["-r", "publish", "--tag", DIST_TAG, "--access", "public", "--no-git-checks"];
  if (!real) args.push("--dry-run");
  console.log(`${real ? "PUBLISHING" : "dry run"}: pnpm ${args.join(" ")}`);
  const r = spawnSync("pnpm", args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail(`pnpm publish exited ${r.status}`);
  if (!real) console.log("dry run only; re-run with --yes to publish");
} finally {
  for (const f of copied) rmSync(f, { force: true });
}
