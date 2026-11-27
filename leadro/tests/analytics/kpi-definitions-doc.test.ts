import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KPI_CATALOG } from "@/lib/kpi-catalog";
import { renderKpiDefinitions } from "@/lib/kpi-definitions-doc";

/** docs/KPI_DEFINITIONS.md is generated from the catalog (spec 13.4); this keeps the committed file equal to it. */
const DOC = readFileSync(path.resolve(__dirname, "../../docs/KPI_DEFINITIONS.md"), "utf8");

describe("docs/KPI_DEFINITIONS.md", () => {
  it("is exactly what `npm run kpi:docs` generates from src/lib/kpi-catalog.ts", () => {
    expect(DOC, "run `npm run kpi:docs` and commit the result").toBe(renderKpiDefinitions());
  });

  it("has one section per KPI", () => {
    for (const kpi of KPI_CATALOG) expect(DOC).toContain(`### \`${kpi.key}\``);
  });
});
