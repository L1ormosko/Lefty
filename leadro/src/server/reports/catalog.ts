import { ValidationError } from "@/server/core";
import type { ReportDataset } from "./dataset-types";
import { ledgerEntriesDataset, paymentsDataset } from "./datasets-finance";
import { customersDataset, leadsDataset, recoveryCasesDataset } from "./datasets-sales";
import { followUpTasksDataset, jobOutcomesDataset, jobsDataset, trainingRecordsDataset } from "./datasets-work";

/**
 * The dataset registry (spec 13.5). Adding a dataset = one definition in a `datasets-*.ts` file + one entry here + its
 * labels in the three catalogs (`REPORT.DATASET.<KEY>`, `REPORT.COLUMN.<column>`; pinned by tests/reports).
 */
export const REPORT_DATASETS: readonly ReportDataset[] = [
  jobsDataset,
  jobOutcomesDataset,
  leadsDataset,
  customersDataset,
  recoveryCasesDataset,
  followUpTasksDataset,
  trainingRecordsDataset,
  paymentsDataset,
  ledgerEntriesDataset,
];

export const REPORT_DATASET_KEYS: readonly string[] = REPORT_DATASETS.map((dataset) => dataset.key);

const byKey = new Map(REPORT_DATASETS.map((dataset) => [dataset.key, dataset]));

/** The dataset with this key. @throws ValidationError (field `datasetKey`) for an unknown key. */
export function getDataset(key: string): ReportDataset {
  const dataset = byKey.get(key);
  if (!dataset) throw new ValidationError({ message: "Unknown report dataset.", field: "datasetKey" });
  return dataset;
}
