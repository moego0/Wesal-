/**
 * Merge `src/messages/fragments/*.{ar,en}.json` into the main catalogs.
 *
 * Screens are written concurrently and every one of them needs strings, so they
 * each write their own namespace to a fragment instead of racing on two shared
 * files where the last writer silently wins. This does the merge.
 *
 * It refuses rather than guesses. A merge that half-succeeds produces a catalog
 * that fails `tests/i18n.coverage.test.ts` with a message about a missing key,
 * which points at the symptom and not at the cause — so the checks live here,
 * where the error can say what actually went wrong.
 *
 * Usage:
 *   node scripts/merge-messages.mjs            # refuse to touch existing namespaces
 *   node scripts/merge-messages.mjs --force    # let fragments overwrite them
 *   node scripts/merge-messages.mjs --check    # report what would happen, write nothing
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENTS = path.join(ROOT, "src/messages/fragments");
const LOCALES = ["ar", "en"];

const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

/** Abort with a message a human can act on. */
function fail(message) {
  console.error(`\n  merge-messages: ${message}\n`);
  process.exit(1);
}

/**
 * Every leaf path in a catalog, dotted.
 *
 * Duplicated from the coverage test on purpose: this script must be able to
 * validate a merge before the catalogs are written, and importing a Vitest file
 * from a Node script would drag the test runner in with it.
 */
function leafPaths(node, prefix = "") {
  return Object.entries(node).flatMap(([key, value]) => {
    const at = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" && !Array.isArray(value)
      ? leafPaths(value, at)
      : [at];
  });
}

function resolve(catalog, dotted) {
  return dotted
    .split(".")
    .reduce((node, segment) => (node && typeof node === "object" ? node[segment] : undefined), catalog);
}

/**
 * The invariants the coverage test asserts, checked here so a merge cannot
 * produce a catalog that fails it.
 */
function validatePair(namespace, arNode, enNode) {
  const arPaths = new Set(leafPaths(arNode));
  const enPaths = new Set(leafPaths(enNode));

  const onlyAr = [...arPaths].filter((p) => !enPaths.has(p));
  const onlyEn = [...enPaths].filter((p) => !arPaths.has(p));

  if (onlyAr.length || onlyEn.length) {
    const lines = [
      ...onlyAr.map((p) => `    ar only: ${namespace}.${p}`),
      ...onlyEn.map((p) => `    en only: ${namespace}.${p}`),
    ];
    fail(`the two languages of "${namespace}" are not identical:\n${lines.join("\n")}`);
  }

  const empty = [];
  for (const [locale, node] of [
    ["ar", arNode],
    ["en", enNode],
  ]) {
    for (const p of leafPaths(node)) {
      const text = resolve(node, p);
      // next-intl renders an empty string as the key path, which looks exactly
      // like a missing translation and passes every structural check.
      if (typeof text === "string" && text.trim() === "") empty.push(`${locale}: ${namespace}.${p}`);
      else if (typeof text !== "string") empty.push(`${locale}: ${namespace}.${p} is not a string`);
    }
  }

  if (empty.length) fail(`empty or non-string entries:\n${empty.map((e) => `    ${e}`).join("\n")}`);
}

async function readJson(file) {
  const raw = await readFile(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${path.relative(ROOT, file)} is not valid JSON — ${error.message}`);
  }
}

const files = await readdir(FRAGMENTS);
const namespaces = [
  ...new Set(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.(ar|en)\.json$/, ""))
      // A stray file that does not follow the naming convention would otherwise
      // be treated as a namespace named after its full filename.
      .filter((ns) => files.includes(`${ns}.ar.json`) || files.includes(`${ns}.en.json`)),
  ),
].sort();

if (namespaces.length === 0) fail(`no fragments found in ${path.relative(ROOT, FRAGMENTS)}`);

const catalogs = {
  ar: await readJson(path.join(ROOT, "src/messages/ar.json")),
  en: await readJson(path.join(ROOT, "src/messages/en.json")),
};

const added = [];
const skipped = [];

for (const namespace of namespaces) {
  const nodes = {};

  for (const locale of LOCALES) {
    const file = path.join(FRAGMENTS, `${namespace}.${locale}.json`);
    let parsed;
    try {
      parsed = await readJson(file);
    } catch {
      fail(`"${namespace}" has no ${locale} fragment — expected ${path.relative(ROOT, file)}`);
    }

    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== namespace) {
      fail(
        `${path.relative(ROOT, file)} must contain exactly one top-level key, "${namespace}".\n` +
          `    Found: ${keys.length ? keys.map((k) => JSON.stringify(k)).join(", ") : "none"}`,
      );
    }

    nodes[locale] = parsed[namespace];
  }

  validatePair(namespace, nodes.ar, nodes.en);

  if (namespace in catalogs.ar || namespace in catalogs.en) {
    if (!force) {
      skipped.push(namespace);
      continue;
    }
  }

  // Appended in place, never re-sorted. The catalog's top-level order is
  // hand-chosen — shared vocabulary first, then one namespace per screen — and
  // sorting it would turn a purely additive merge into a whole-file diff.
  for (const locale of LOCALES) {
    catalogs[locale][namespace] = nodes[locale];
  }

  added.push(namespace);
}

if (checkOnly) {
  console.log(`would merge: ${added.length ? added.join(", ") : "nothing"}`);
  if (skipped.length) console.log(`already present (needs --force): ${skipped.join(", ")}`);
  process.exit(0);
}

for (const locale of LOCALES) {
  await writeFile(
    path.join(ROOT, `src/messages/${locale}.json`),
    `${JSON.stringify(catalogs[locale], null, 2)}\n`,
    "utf8",
  );
}

console.log(`merged ${added.length} namespace(s): ${added.join(", ") || "none"}`);
if (skipped.length) {
  console.log(
    `\nkept existing (not overwritten): ${skipped.join(", ")}\n` +
      `  These already exist in the main catalogs. If the fragment is the newer\n` +
      `  version, re-run with --force; if the catalog is, delete the fragment.`,
  );
}
