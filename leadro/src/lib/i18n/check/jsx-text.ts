export interface HardcodedTextFinding {
  line: number;
  text: string;
  kind: "jsx-text" | "attribute";
}

/** Attributes whose value is shown to (or announced to) users. */
const USER_FACING_ATTRIBUTES = ["title", "placeholder", "alt", "aria-label", "aria-description"];

const IGNORE_MARKER = "i18n-ignore";

/**
 * A JSX tag (opening, closing or self-closing). The lookbehind rejects `<` directly after an
 * identifier or `)`/`]`, which is how TypeScript generics (`Map<string, number>`, `useState<T>(…)`)
 * look; real JSX tags follow `(`, `>`, `}`, `=`, `return`, whitespace, etc. `=>` inside attribute
 * values is consumed explicitly so it does not end the tag early.
 */
const TAG = /(?<![\w$\])])<\/?[A-Za-z][\w.:-]*(?:\s(?:=>|[^<>])*?)?\/?>/g;
const ATTRIBUTE = new RegExp(`\\b(${USER_FACING_ATTRIBUTES.join("|")})=(?:"([^"{}]*)"|'([^'{}]*)')`, "g");
const HAS_LETTER = /\p{L}/u;
const HTML_ENTITY = /&(?:#\d+|#x[\da-f]+|\w+);/gi;

/**
 * Heuristic scan for user-facing text written directly in JSX (spec §16.3: all UI text must come
 * from translation keys). It is a lint-grade check, not a parser. After every tag it reads the
 * children: literal text runs (including text next to `{expressions}`, e.g. `Hello {name}` or
 * `{n} items left`) are reported, `{…}` expressions are skipped. It also reports string-literal
 * values of title/placeholder/alt/aria-label. Escape hatch for legitimate cases (brand names,
 * symbols): put `i18n-ignore` in a comment on the same line.
 */
export function findHardcodedJsxText(source: string): HardcodedTextFinding[] {
  const lines = source.split("\n");
  const clean = blankOutComments(source);
  const findings: HardcodedTextFinding[] = [];
  const seenOffsets = new Set<number>();
  const isIgnored = (line: number) => lines[line - 1]?.includes(IGNORE_MARKER) ?? false;

  for (const tag of clean.matchAll(TAG)) {
    for (const run of childTextRuns(clean, (tag.index ?? 0) + tag[0].length)) {
      if (seenOffsets.has(run.offset)) continue;
      seenOffsets.add(run.offset);
      const line = lineNumberAt(clean, run.offset);
      if (!isIgnored(line)) findings.push({ line, text: run.text, kind: "jsx-text" });
    }
  }

  for (const match of clean.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? "";
    if (!HAS_LETTER.test(value)) continue;
    const line = lineNumberAt(clean, match.index ?? 0);
    if (!isIgnored(line)) findings.push({ line, text: `${match[1]}="${value}"`, kind: "attribute" });
  }
  return findings.sort((a, b) => a.line - b.line);
}

interface TextRun {
  /** Offset of the first non-blank character. */
  offset: number;
  text: string;
}

/**
 * Walks the children that follow a tag: collects text runs until the next tag, skipping balanced
 * `{…}` expressions, and stops at the next `<` (child or closing tag; its own TAG match continues).
 */
function childTextRuns(source: string, start: number): TextRun[] {
  const runs: TextRun[] = [];
  let position = start;
  while (position < source.length) {
    let next = position;
    while (next < source.length && source[next] !== "<" && source[next] !== "{") next++;
    const raw = source.slice(position, next);
    const text = raw.replace(HTML_ENTITY, " ").replace(/\s+/g, " ").trim();
    if (HAS_LETTER.test(text) && looksLikeProse(raw)) {
      runs.push({ offset: position + (raw.length - raw.trimStart().length), text });
    }
    if (source[next] !== "{") break;
    const afterExpression = skipBalancedBraces(source, next);
    if (afterExpression === -1) break;
    position = afterExpression;
  }
  return runs;
}

/** Statement punctuation means the "text" is really code that follows a self-closing tag. */
function looksLikeProse(raw: string): boolean {
  const withoutEntities = raw.replace(HTML_ENTITY, " ");
  return !withoutEntities.includes(";") && !withoutEntities.includes("=>") && !withoutEntities.includes("}");
}

/** Index just after the `}` matching the `{` at `open`, or -1 if unbalanced. */
function skipBalancedBraces(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Replaces comment bodies with spaces (keeping newlines) so line numbers stay correct. */
function blankOutComments(source: string): string {
  const blank = (comment: string) => comment.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, prefix: string) => prefix + blank(m.slice(prefix.length)));
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}
