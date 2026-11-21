import ts from "typescript";

export interface HardcodedTextFinding {
  line: number;
  text: string;
  kind: "jsx-text" | "attribute";
}

/** Attributes whose value is shown to (or announced to) users. */
const USER_FACING_ATTRIBUTES = new Set(["title", "placeholder", "alt", "aria-label", "aria-description"]);

const IGNORE_MARKER = "i18n-ignore";
const HAS_LETTER = /\p{L}/u;
const HTML_ENTITY = /&(?:#\d+|#x[\da-f]+|\w+);/gi;

/**
 * Finds user-facing text written directly in JSX (spec §16.3: all UI text must come from
 * translation keys). The source is parsed with the TypeScript compiler, so only real `JsxText`
 * nodes and string-literal values of title/placeholder/alt/aria-label are inspected; type
 * annotations, generics, arrows and other code can never be mistaken for text.
 * Escape hatch for legitimate cases (brand names, symbols): put `i18n-ignore` in a comment on
 * the same line.
 */
export function findHardcodedJsxText(source: string): HardcodedTextFinding[] {
  const file = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const findings: HardcodedTextFinding[] = [];

  const lineOf = (position: number) => file.getLineAndCharacterOfPosition(position).line + 1;
  const report = (position: number, text: string, kind: HardcodedTextFinding["kind"]) => {
    const line = lineOf(position);
    if (!lines[line - 1]?.includes(IGNORE_MARKER)) findings.push({ line, text, kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(HTML_ENTITY, " ").replace(/\s+/g, " ").trim();
      if (HAS_LETTER.test(text)) {
        const raw = node.getFullText();
        const firstNonBlank = node.getFullStart() + (raw.length - raw.trimStart().length);
        report(firstNonBlank, text, "jsx-text");
      }
    } else if (
      ts.isJsxAttribute(node) &&
      USER_FACING_ATTRIBUTES.has(node.name.getText(file)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      HAS_LETTER.test(node.initializer.text)
    ) {
      report(node.getStart(file), `${node.name.getText(file)}="${node.initializer.text}"`, "attribute");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return findings.sort((a, b) => a.line - b.line);
}
