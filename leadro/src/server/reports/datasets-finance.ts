import { LedgerEntryType, LedgerSource, PaymentMethod, PaymentOrigin, PaymentRecordStatus, type Prisma } from "@prisma/client";
import { financeJobScopeColumns, ledgerEntryScopeColumns } from "@/server/ledger";
import { columnsFrom, viaRelation, type ReportDataset } from "./dataset-types";

/**
 * Financial datasets (spec 13.3, 22.2: financial reports are sensitive): payments and ledger entries. Neither owner has a
 * field map: the whole record is guarded by the finance permission (`finance_payments.view`, `finance_ledger.view`), so
 * every column is `base` of that permission. Finance scopes never include OWN / ASSIGNED (ledger/job-ref.ts), which is
 * also the reports rule. Amounts are listed per row with their currency; nothing is summed across currencies.
 */

const values = (enumObject: Record<string, string>) => Object.values(enumObject);
const column = columnsFrom(null);

/** A payment's scope follows its job's unit / legal entity (as `listPayments`). */
export const paymentsDataset: ReportDataset = {
  key: "payments",
  viewPermission: "finance_payments.view",
  exportPermission: "financial_reports.export",
  scopeColumns: viaRelation("job", financeJobScopeColumns as ReportDataset["scopeColumns"]),
  orgUnitFilter: (orgUnitIds) => ({ job: { orgUnitId: { in: orgUnitIds } } }),
  dateColumn: "createdAt",
  defaultSort: { column: "createdAt", direction: "desc" },
  maxExportRows: 10_000,
  columns: [
    column("id", "id"),
    column("jobId", "id", { filter: "in" }),
    column("customerId", "id", { filter: "in" }),
    column("outcomeId", "id"),
    column("method", "enum", { enumValues: values(PaymentMethod), filter: "in" }),
    column("status", "enum", { enumValues: values(PaymentRecordStatus), filter: "in" }),
    column("origin", "enum", { enumValues: values(PaymentOrigin), filter: "in" }),
    column("amountMinor", "money", { currencyColumn: "currency" }),
    column("currency", "currency", { filter: "in" }),
    column("reference", "text"),
    column("orgUnitId", "id"),
    column("receivedAt", "instant", { sortable: true }),
    column("failedAt", "instant"),
    column("voidedAt", "instant"),
    column("createdAt", "instant", { sortable: true }),
  ],
  findMany: (tx, args) => tx.payment.findMany(args as Prisma.PaymentFindManyArgs),
  count: (tx, where) => tx.payment.count({ where: where as Prisma.PaymentWhereInput }),
};

/** Ledger entries attribute to the unit / legal entity snapshot taken at posting (an entry never moves). */
export const ledgerEntriesDataset: ReportDataset = {
  key: "ledger_entries",
  viewPermission: "finance_ledger.view",
  exportPermission: "finance_ledger.export",
  scopeColumns: ledgerEntryScopeColumns as ReportDataset["scopeColumns"],
  orgUnitFilter: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  dateColumn: "occurredAt",
  defaultSort: { column: "occurredAt", direction: "desc" },
  maxExportRows: 50_000,
  columns: [
    column("id", "id"),
    column("type", "enum", { enumValues: values(LedgerEntryType), filter: "in" }),
    column("source", "enum", { enumValues: values(LedgerSource), filter: "in" }),
    column("amountMinor", "money", { currencyColumn: "currency" }),
    column("currency", "currency", { filter: "in" }),
    column("jobId", "id", { filter: "in" }),
    column("customerId", "id", { filter: "in" }),
    column("outcomeId", "id"),
    column("paymentId", "id"),
    column("orgUnitId", "id"),
    column("legalEntityId", "id", { filter: "in" }),
    column("reversesEntryId", "id"),
    column("memo", "text"),
    column("occurredAt", "instant", { sortable: true }),
    column("recordedAt", "instant", { sortable: true }),
  ],
  findMany: (tx, args) => tx.ledgerEntry.findMany(args as Prisma.LedgerEntryFindManyArgs),
  count: (tx, where) => tx.ledgerEntry.count({ where: where as Prisma.LedgerEntryWhereInput }),
};
