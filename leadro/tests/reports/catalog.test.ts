import { describe, expect, it } from "vitest";
import { CATALOGS } from "@/lib/i18n";
import { CUSTOMER_FIELD_MAP, JOB_FIELD_MAP, JOB_OUTCOME_FIELD_MAP, isPermissionKey } from "@/server/authz";
import { REPORT_DATASETS } from "@/server/reports";

const upperSnake = (key: string) => key.replace(/(?<!^)(?=[A-Z])/g, "_").toUpperCase();

describe("report dataset registry", () => {
  it.each(REPORT_DATASETS.map((dataset) => [dataset.key, dataset] as const))("%s is well formed", (_key, dataset) => {
    expect(dataset.key).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
    expect(isPermissionKey(dataset.viewPermission)).toBe(true);
    expect(isPermissionKey(dataset.exportPermission)).toBe(true);
    expect(dataset.exportPermission.endsWith(".export")).toBe(true);
    expect(dataset.maxExportRows).toBeGreaterThan(0);

    const keys = dataset.columns.map((column) => column.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("id");
    for (const key of keys) expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/);
    expect(keys).toContain(dataset.dateColumn);
    expect(dataset.columns.find((column) => column.key === dataset.defaultSort.column)?.sortable).toBe(true);

    for (const column of dataset.columns) {
      if (column.type === "money") {
        // An amount is never shown without its own currency, and both are protected by the same field set.
        const currency = dataset.columns.find((other) => other.key === column.currencyColumn);
        expect(currency?.type).toBe("currency");
        expect(currency?.fieldSet).toBe(column.fieldSet);
      }
      if (column.type === "enum") expect(column.enumValues?.length).toBeGreaterThan(0);
    }
    const sets = new Set(dataset.columns.map((column) => column.fieldSet));
    if (sets.size > 1) {
      expect(dataset.rowScope).toBeDefined();
      expect(dataset.scopeSelect).toBeDefined();
    }
  });

  it("takes sensitivity from the owners' field maps, never re-deciding it", () => {
    const fieldSet = (datasetKey: string, column: string) =>
      REPORT_DATASETS.find((dataset) => dataset.key === datasetKey)?.columns.find((entry) => entry.key === column)?.fieldSet;
    expect(fieldSet("jobs", "quotedAmountMinor")).toBe(JOB_FIELD_MAP.quotedAmountMinor);
    expect(fieldSet("jobs", "quotedAmountMinor")).toBe("financial");
    expect(fieldSet("customers", "taxId")).toBe(CUSTOMER_FIELD_MAP.taxId);
    expect(fieldSet("customers", "taxId")).toBe("billing");
    expect(fieldSet("job_outcomes", "chargedAmountMinor")).toBe(JOB_OUTCOME_FIELD_MAP.chargedAmountMinor);
    expect(fieldSet("job_outcomes", "outcome")).toBe("base");
  });

  it("labels every dataset and column in every catalog", () => {
    const missing: string[] = [];
    for (const catalog of Object.values(CATALOGS)) {
      const messages = catalog.messages as Record<string, string>;
      for (const dataset of REPORT_DATASETS) {
        const datasetKey = `REPORT.DATASET.${dataset.key.toUpperCase()}`;
        if (!messages[datasetKey]) missing.push(`${catalog.locale} ${datasetKey}`);
        for (const column of dataset.columns) {
          const columnKey = `REPORT.COLUMN.${upperSnake(column.key)}`;
          if (!messages[columnKey]) missing.push(`${catalog.locale} ${columnKey}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
