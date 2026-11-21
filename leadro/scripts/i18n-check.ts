/**
 * `npm run i18n:check` — fails (exit 1) when
 *   1. the en-US / es-US / he-IL catalogs have missing or extra keys, or mismatched {placeholders};
 *   2. a component under src/app or src/components has hardcoded user-facing text (heuristic).
 * Ignored for (2): src/app/dev/** (developer gallery) and test files.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CATALOGS } from "../src/lib/i18n/catalogs";
import { checkCatalogs } from "../src/lib/i18n/check/catalog-check";
import { findHardcodedJsxText } from "../src/lib/i18n/check/jsx-text";

const root = join(__dirname, "..");
const SCANNED_DIRECTORIES = ["src/app", "src/components"];
const IGNORED_PREFIXES = [`src${sep}app${sep}dev${sep}`];
const TEST_FILE = /\.(test|spec)\.tsx?$|(^|[\\/])__tests__[\\/]/;

function* listTsxFiles(directory: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return; // directory does not exist (yet)
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* listTsxFiles(path);
    else if (path.endsWith(".tsx")) yield path;
  }
}

const problems: string[] = checkCatalogs(CATALOGS);

for (const directory of SCANNED_DIRECTORIES) {
  for (const file of listTsxFiles(join(root, directory))) {
    const relativePath = relative(root, file);
    if (TEST_FILE.test(relativePath) || IGNORED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
    for (const finding of findHardcodedJsxText(readFileSync(file, "utf8"))) {
      problems.push(`${relativePath}:${finding.line} hardcoded text (${finding.kind}): ${finding.text}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`i18n:check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("i18n:check passed");
