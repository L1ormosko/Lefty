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

  it.each([
    ["text before an expression", `const A = () => <p>Hello {name}</p>;`],
    ["text after an expression", `const A = () => <p>{n} items left</p>;`],
    ["text with a colon before an expression", `const A = () => <p>Total: {x}</p>;`],
    ["text with an ampersand", `const A = () => <p>Save & close</p>;`],
    ["text with parentheses", `const A = () => <p>Call us (24/7)</p>;`],
    ["text after a closing tag", `const A = () => <p><b>{n}</b> items</p>;`],
    ["text in a conditional branch", `const A = () => <p>{ok && <span>Done</span>}</p>;`],
  ])("flags %s", (_label, source) => {
    expect(findHardcodedJsxText(source)).toHaveLength(1);
  });

  it("does not flag code after a self-closing tag or entity-only text", () => {
    expect(findHardcodedJsxText(`const A = () => <hr />;\nexport default A;`)).toEqual([]);
    expect(findHardcodedJsxText(`const A = () => <p>&nbsp;&mdash;</p>;`)).toEqual([]);
    expect(findHardcodedJsxText(`const A = () => <p onClick={() => go()}>{t("X.Y")}</p>;`)).toEqual([]);
  });

  it("does not mistake generics in components or hooks for JSX", () => {
    const source = `
      export function List<T>({ items }: { items: Array<T> }) {
        const [s, setS] = useState<string | null>(null);
        const f = <T,>(x: T) => x;
        return <ul>{items.map((i) => <li key={String(i)}>{t("COMMON.SAVE")}</li>)}</ul>;
      }`;
    expect(findHardcodedJsxText(source)).toEqual([]);
  });

  it("does not treat TypeScript code between JSX expressions as text (round 2 regressions)", () => {
    const source = `
      export function DataTable() {
        return (
          <th>
            {sort.direction === "desc" ? (
              <DownIcon />
            ) : sort.direction === "asc" ? (
              <UpIcon />
            ) : null}
          </th>
        );
      }
      export function FieldError({ id }: FieldErrorProps) {
        return <p id={id} />;
      }
      export interface FieldProps {
        label: string;
      }
      export function Field({ label }: FieldProps) {
        return <label>{label}</label>;
      }
      const toneIcon = { success: <Check />, warning: <Warn />, danger: <X />, info: <I />, neutral: <Dot /> };
      export function StatusBadge({ tone }: StatusBadgeProps) {
        return <span>{toneIcon[tone]}</span>;
      }
      export const Icon = (props: IconProps & { size?: number }) => <svg {...props} />;`;
    expect(findHardcodedJsxText(source)).toEqual([]);
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
