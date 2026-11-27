import { CustomerKind, LeadStatus, RecoveryStatus, WorkPriority, type Prisma } from "@prisma/client";
import { CUSTOMER_FIELD_MAP, LEAD_FIELD_MAP } from "@/server/authz";
import { customerScopeColumns, leadScopeColumns } from "@/server/customers";
import { CASE_FIELD_MAP, caseScopeColumns } from "@/server/recovery";
import { columnsFrom, unitRowScope, unitScopeSelect, type ReportDataset } from "./dataset-types";

/**
 * Sales datasets: leads, customers, lead recovery cases. Field sets come from `LEAD_FIELD_MAP` (all base: a lead's quote
 * is a sales estimate), `CUSTOMER_FIELD_MAP` (billing columns are the opt-in `billing` set) and the recovery module's
 * `CASE_FIELD_MAP` (all base: visibility is decided by the case's scope). Scope columns are the owners' unit columns.
 */

const values = (enumObject: Record<string, string>) => Object.values(enumObject);
const unitsOnly = (columns: { orgUnit?: unknown; legalEntity?: unknown }) =>
  ({ orgUnit: columns.orgUnit, legalEntity: columns.legalEntity }) as ReportDataset["scopeColumns"];

const leadColumn = columnsFrom(LEAD_FIELD_MAP);

export const leadsDataset: ReportDataset = {
  key: "leads",
  viewPermission: "leads.view",
  exportPermission: "leads.export",
  scopeColumns: unitsOnly(leadScopeColumns),
  orgUnitFilter: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  dateColumn: "createdAt",
  defaultSort: { column: "createdAt", direction: "desc" },
  maxExportRows: 10_000,
  columns: [
    leadColumn("id", "id"),
    leadColumn("number", "integer", { sortable: true }),
    leadColumn("status", "enum", { enumValues: values(LeadStatus), filter: "in" }),
    leadColumn("priority", "enum", { enumValues: values(WorkPriority), filter: "in" }),
    leadColumn("sourceId", "id", { filter: "in" }),
    leadColumn("campaign", "text"),
    leadColumn("customerId", "id", { filter: "in" }),
    leadColumn("contactName", "text"),
    leadColumn("contactEmail", "text"),
    leadColumn("contactPhone", "text"),
    leadColumn("addressCity", "text"),
    leadColumn("jobTypeId", "id", { filter: "in" }),
    leadColumn("serviceCategory", "text"),
    leadColumn("quotedAmountMinor", "money", { currencyColumn: "currency" }),
    leadColumn("currency", "currency", { filter: "in" }),
    leadColumn("orgUnitId", "id"),
    leadColumn("nextFollowUpAt", "instant", { sortable: true }),
    leadColumn("closedReason", "text"),
    leadColumn("createdAt", "instant", { sortable: true }),
    leadColumn("archivedAt", "instant"),
  ],
  findMany: (tx, args) => tx.lead.findMany(args as Prisma.LeadFindManyArgs),
  count: (tx, where) => tx.lead.count({ where: where as Prisma.LeadWhereInput }),
};

const customerColumn = columnsFrom(CUSTOMER_FIELD_MAP);

/** Customers hold contact data of private people (spec 22.2): a smaller synchronous cap than the other datasets. */
export const customersDataset: ReportDataset = {
  key: "customers",
  viewPermission: "customers.view",
  exportPermission: "customers.export",
  scopeColumns: unitsOnly(customerScopeColumns),
  orgUnitFilter: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  dateColumn: "createdAt",
  defaultSort: { column: "createdAt", direction: "desc" },
  maxExportRows: 5_000,
  columns: [
    customerColumn("id", "id"),
    customerColumn("number", "integer", { sortable: true }),
    customerColumn("kind", "enum", { enumValues: values(CustomerKind), filter: "in" }),
    customerColumn("name", "text", { sortable: true }),
    customerColumn("email", "text"),
    customerColumn("phone", "text"),
    customerColumn("preferredLocale", "text"),
    customerColumn("doNotContact", "boolean", { filter: "boolean" }),
    customerColumn("orgUnitId", "id"),
    customerColumn("billingName", "text"),
    customerColumn("billingEmail", "text"),
    customerColumn("taxId", "text"),
    customerColumn("paymentTerms", "text"),
    customerColumn("createdAt", "instant", { sortable: true }),
    customerColumn("archivedAt", "instant"),
  ],
  scopeSelect: unitScopeSelect(),
  rowScope: unitRowScope(),
  findMany: (tx, args) => tx.customer.findMany(args as Prisma.CustomerFindManyArgs),
  count: (tx, where) => tx.customer.count({ where: where as Prisma.CustomerWhereInput }),
};

const caseColumn = columnsFrom(CASE_FIELD_MAP);

/** Recovery cases attribute to the unit copied from the job (`LeadRecoveryCase.orgUnitId`), anchored on the lost visit. */
export const recoveryCasesDataset: ReportDataset = {
  key: "recovery_cases",
  viewPermission: "recovery.view",
  exportPermission: "leads.export",
  scopeColumns: unitsOnly(caseScopeColumns),
  orgUnitFilter: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  dateColumn: "outcomeAt",
  defaultSort: { column: "outcomeAt", direction: "desc" },
  maxExportRows: 10_000,
  columns: [
    caseColumn("id", "id"),
    caseColumn("number", "integer", { sortable: true }),
    caseColumn("jobId", "id", { filter: "in" }),
    caseColumn("customerId", "id", { filter: "in" }),
    caseColumn("leadId", "id"),
    caseColumn("orgUnitId", "id"),
    caseColumn("lostReasonId", "id", { filter: "in" }),
    caseColumn("status", "enum", { enumValues: values(RecoveryStatus), filter: "in" }),
    caseColumn("priority", "enum", { enumValues: values(WorkPriority), filter: "in" }),
    caseColumn("assignedToId", "id", { filter: "in" }),
    caseColumn("outcomeAt", "instant", { sortable: true }),
    caseColumn("initialValueMinor", "money", { currencyColumn: "currency" }),
    caseColumn("estimatedValueMinor", "money", { currencyColumn: "currency" }),
    caseColumn("currency", "currency", { filter: "in" }),
    caseColumn("recoveredAt", "instant", { sortable: true }),
    caseColumn("recoveredAmountMinor", "money", { currencyColumn: "currency" }),
    caseColumn("collectedAmountMinor", "money", { currencyColumn: "currency" }),
    caseColumn("attemptCount", "integer"),
    caseColumn("closedAt", "instant"),
    caseColumn("closeReason", "text"),
    caseColumn("createdAt", "instant", { sortable: true }),
  ],
  findMany: (tx, args) => tx.leadRecoveryCase.findMany(args as Prisma.LeadRecoveryCaseFindManyArgs),
  count: (tx, where) => tx.leadRecoveryCase.count({ where: where as Prisma.LeadRecoveryCaseWhereInput }),
};
