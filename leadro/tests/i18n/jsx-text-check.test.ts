import { describe, expect, it } from "vitest";
import { findHardcodedJsxText } from "@/lib/i18n/check/jsx-text";

describe("hardcoded JSX text heuristic", () => {
  it("flags literal text between tags with its line number", () => {
    const source = `export const A = () => (\n  <div>\n    <button>Save changes</button>\n  </div>\n);`;
    expect(findHardcodedJsxText(source)).toEqual([{ line: 3, text: "Save changes", kind: "jsx-text" }]);
  });

  it("flags user-facing attributes", () => {
    const findings = findHardcodedJsxText(`const A = () => <input placeholder="Search customers" aria-label="Search" />;`);
    expect(findings.map((f) => f.kind)).toEqual(["attribute", "attribute"]);
  });

  it("flags Hebrew and Spanish text too", () => {
    expect(findHardcodedJsxText(`const A = () => <p>שמירה</p>;`)).toHaveLength(1);
    expect(findHardcodedJsxText(`const A = () => <p>Guardar cambios</p>;`)).toHaveLength(1);
  });

  it("accepts translated text, expressions, symbols and non-text attributes", () => {
    const source = `
      const A = () => (
        <div className="p-4" data-testid="x">
          <button>{t("COMMON.SAVE")}</button>
          <span>{count} / {total}</span>
          <span>•</span>
          <input placeholder={t("COMMON.SEARCH")} aria-label={label} />
        </div>
      );`;
    expect(findHardcodedJsxText(source)).toEqual([]);
  });

  it("does not mistake TypeScript generics, arrows or comparisons for JSX text", () => {
    const source = `
      const m = new Map<string, number>();
      const f = async (): Promise<void> => { if (a > b && c < d) return; };
      const g = (x: Array<string>) => x.length > 0;`;
    expect(findHardcodedJsxText(source)).toEqual([]);
  });

  it("ignores comments and honours the i18n-ignore marker", () => {
    const source = `
      // <p>Commented out text</p>
      /* <p>Also commented</p> */
      const A = () => <b>LEADRO</b>; // i18n-ignore brand name`;
    expect(findHardcodedJsxText(source)).toEqual([]);
  });
});
