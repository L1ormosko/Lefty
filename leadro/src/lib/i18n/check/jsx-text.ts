export interface HardcodedTextFinding {
  line: number;
  text: string;
  kind: "jsx-text" | "attribute";
}

/** Attributes whose value is shown to (or announced to) users. */
const USER_FACING_ATTRIBUTES = ["title", "placeholder", "alt", "aria-label", "aria-description"];

const IGNORE_MARKER = "i18n-ignore";

// Text between a closing ">" and the next "<". Characters that only occur in code (not prose)
// are excluded so `a > b && c < d`, `=>` and generics are not reported.
const JSX_TEXT = />([^<>{}=;()&|]*)</g;
const ATTRIBUTE = new RegExp(`\\b(${USER_FACING_ATTRIBUTES.join("|")})=(?:"([^"{}]*)"|'([^'{}]*)')`, "g");
const HAS_LETTER = /\p{L}/u;

/**
 * Heuristic scan for user-facing text written directly in JSX (spec §16.3: all UI text must come
 * from translation keys). It is a lint-grade check, not a parser: it looks for prose between tags
 * and for string-literal values of title/placeholder/alt/aria-label. Escape hatch for legitimate
 * cases (brand names, symbols): put `i18n-ignore` in a comment on the same line.
 */
export function findHardcodedJsxText(source: string): HardcodedTextFinding[] {
  const lines = source.split("\n");
  const findings: HardcodedTextFinding[] = [];
  const clean = blankOutComments(source);

  for (const match of clean.matchAll(JSX_TEXT)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    if (!HAS_LETTER.test(text)) continue;
    const line = lineNumberAt(clean, (match.index ?? 0) + 1 + leadingBlankLength(match[1]));
    if (!lines[line - 1]?.includes(IGNORE_MARKER)) findings.push({ line, text, kind: "jsx-text" });
  }

  for (const match of clean.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? "";
    if (!HAS_LETTER.test(value)) continue;
    const line = lineNumberAt(clean, match.index ?? 0);
    if (!lines[line - 1]?.includes(IGNORE_MARKER)) findings.push({ line, text: `${match[1]}="${value}"`, kind: "attribute" });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** Replaces comment bodies with spaces (keeping newlines) so line numbers stay correct. */
function blankOutComments(source: string): string {
  const blank = (comment: string) => comment.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\n]*/g, (m, prefix: string) => prefix + blank(m.slice(prefix.length)));
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function leadingBlankLength(text: string): number {
  return text.length - text.trimStart().length;
}
