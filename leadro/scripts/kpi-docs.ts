/**
 * `npm run kpi:docs` — regenerates docs/KPI_DEFINITIONS.md from the KPI catalog (src/lib/kpi-catalog.ts, spec 13.4).
 * `tests/analytics/kpi-definitions-doc.test.ts` fails whenever the committed file differs from what this writes.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderKpiDefinitions } from "../src/lib/kpi-definitions-doc";

const target = join(__dirname, "..", "docs", "KPI_DEFINITIONS.md");
writeFileSync(target, renderKpiDefinitions());
console.log(`wrote ${target}`);
