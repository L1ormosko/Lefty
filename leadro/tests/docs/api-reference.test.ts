import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps docs/API_REFERENCE.md in step with the routes: every exported HTTP method of every
 * `src/app/api/v1/<...>/route.ts` must have a `### METHOD /api/v1/...` heading. It checks that an
 * operation is listed, not that its description is right; that part stays a review concern.
 */
const API_ROOT = path.resolve(__dirname, "../../src/app/api");
const DOC = readFileSync(path.resolve(__dirname, "../../docs/API_REFERENCE.md"), "utf8");
const METHOD_EXPORT = /^export const (GET|POST|PUT|PATCH|DELETE)\b/gm;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

/** `.../api/v1/employees/[id]/terminate/route.ts` becomes `/api/v1/employees/{id}/terminate`. */
function urlPathOf(file: string): string {
  const relative = path.relative(path.dirname(API_ROOT), path.dirname(file)).split(path.sep).join("/");
  return `/${relative.replace(/\[([^\]]+)\]/g, "{$1}")}`;
}

const operations = routeFiles(API_ROOT).flatMap((file) => {
  const methods = [...readFileSync(file, "utf8").matchAll(METHOD_EXPORT)].map((match) => match[1]);
  return methods.map((method) => ({ method, url: urlPathOf(file), file: path.relative(API_ROOT, file) }));
});

describe("docs/API_REFERENCE.md", () => {
  it("finds the routes it is supposed to document", () => {
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation.url.startsWith("/api/v1/"))).toBe(true);
  });

  it.each(operations.map((operation) => [`${operation.method} ${operation.url}`, operation] as const))(
    "documents %s",
    (_label, operation) => {
      const heading = new RegExp(`^### ${operation.method} ${operation.url.replace(/[{}]/g, "\\$&")}\\s*$`, "m");
      expect(DOC, `${operation.file} is not documented in docs/API_REFERENCE.md`).toMatch(heading);
    },
  );

  it("lists no operation that does not exist (a renamed or removed route)", () => {
    const existing = new Set(operations.map((operation) => `${operation.method} ${operation.url}`));
    const documented = [...DOC.matchAll(/^### (GET|POST|PUT|PATCH|DELETE) (\/api\/v1\/\S+)$/gm)].map(
      (match) => `${match[1]} ${match[2]}`,
    );
    expect(documented.filter((entry) => !existing.has(entry))).toEqual([]);
  });
});
