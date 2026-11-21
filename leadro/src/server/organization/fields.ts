import type { Prisma } from "@prisma/client";
import { baseFieldMap } from "@/server/authz";

/** Org units carry no sensitive field sets: every column is `base`. */
export const ORG_UNIT_FIELD_MAP = baseFieldMap([
  "id",
  "type",
  "name",
  "code",
  "parentId",
  "legalEntityId",
  "active",
  "address",
  "timeZone",
  "defaultLocale",
  "operatingHours",
  "createdAt",
  "updatedAt",
]);

export const LEGAL_ENTITY_FIELD_MAP = baseFieldMap(["id", "name", "legalName", "active", "createdAt", "updatedAt"]);

export const ORG_UNIT_SELECT = {
  id: true,
  type: true,
  name: true,
  code: true,
  parentId: true,
  legalEntityId: true,
  active: true,
  address: true,
  timeZone: true,
  defaultLocale: true,
  operatingHours: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrgUnitSelect;

export const LEGAL_ENTITY_SELECT = {
  id: true,
  name: true,
  legalName: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LegalEntitySelect;

export type OrgUnitRow = Prisma.OrgUnitGetPayload<{ select: typeof ORG_UNIT_SELECT }>;
export type LegalEntityRow = Prisma.LegalEntityGetPayload<{ select: typeof LEGAL_ENTITY_SELECT }>;
