import type { OrgUnitType, ScopeType } from "@prisma/client";

/**
 * Development seed data: two fictional US field-service companies, so cross-tenant isolation can
 * be tried by hand (log in to one, confirm you never see the other). Everything here is made up.
 */

export interface UnitSpec {
  /** Stable key people refer to; not stored. */
  key: string;
  type: OrgUnitType;
  name: string;
  /** Which of the tenant's legal entities employs people here (key of `legalEntities`). */
  legalEntity?: string;
  address?: { line1: string; city: string; state: string; postalCode: string };
  timeZone?: string;
  children?: UnitSpec[];
}

export interface SeedScope {
  type: ScopeType;
  /** For ORG_UNIT scopes: the unit key. */
  unitKey?: string;
}

export interface PersonSpec {
  /** Role template key (`ROLE_TEMPLATES[].key`). */
  templateKey: string;
  /** Local part of the login email. */
  login: string;
  jobTitle: string;
  /** Unit the employee is placed in. */
  placeAt: string;
  scopes: SeedScope[];
}

export interface TenantSpec {
  slug: string;
  name: string;
  legalEntities: Array<{ key: string; name: string; legalName: string }>;
  units: UnitSpec[];
  firstNames: string[];
  lastNames: string[];
}

/**
 * One person per role template (spec 4.4). Scopes follow each template's `suggestedScopeTypes`:
 * company-level roles are tenant-wide, managers cover their state/region/city subtree, the
 * technician sees their own records and the jobs assigned to them.
 */
export const PEOPLE: PersonSpec[] = [
  { templateKey: "OWNER_CEO", login: "owner", jobTitle: "Owner / CEO", placeAt: "bu", scopes: [{ type: "TENANT" }] },
  { templateKey: "COO", login: "coo", jobTitle: "VP Operations", placeAt: "bu", scopes: [{ type: "TENANT" }] },
  { templateKey: "FINANCE_DIRECTOR", login: "finance", jobTitle: "Finance Director", placeAt: "bu", scopes: [{ type: "TENANT" }] },
  { templateKey: "HR_MANAGER", login: "hr", jobTitle: "HR Manager", placeAt: "bu", scopes: [{ type: "TENANT" }] },
  { templateKey: "STATE_MANAGER", login: "state-manager", jobTitle: "Texas State Manager", placeAt: "tx", scopes: [{ type: "ORG_UNIT", unitKey: "tx" }] },
  { templateKey: "REGIONAL_MANAGER", login: "regional-manager", jobTitle: "Regional Manager", placeAt: "tx-region", scopes: [{ type: "ORG_UNIT", unitKey: "tx-region" }] },
  { templateKey: "CITY_MANAGER", login: "city-manager", jobTitle: "City Manager", placeAt: "tx-city", scopes: [{ type: "ORG_UNIT", unitKey: "tx-city" }] },
  { templateKey: "TEAM_LEADER", login: "team-leader", jobTitle: "Team Leader", placeAt: "tx-team", scopes: [{ type: "ORG_UNIT", unitKey: "tx-team" }] },
  { templateKey: "LEAD_OPERATIONS_MANAGER", login: "lead-ops", jobTitle: "Lead Operations Manager", placeAt: "tx", scopes: [{ type: "ORG_UNIT", unitKey: "tx" }] },
  { templateKey: "DISPATCHER", login: "dispatcher", jobTitle: "Dispatcher", placeAt: "tx-city", scopes: [{ type: "ORG_UNIT", unitKey: "tx-city" }] },
  { templateKey: "CUSTOMER_RELATIONS", login: "customer-relations", jobTitle: "Customer Relations", placeAt: "tx-city", scopes: [{ type: "ORG_UNIT", unitKey: "tx-city" }] },
  { templateKey: "TECHNICIAN", login: "technician", jobTitle: "Field Technician", placeAt: "tx-team", scopes: [{ type: "OWN" }, { type: "ASSIGNED" }] },
];

const branch = (city: string, state: string, postalCode: string, timeZone: string) => ({
  address: { line1: "100 Main Street", city, state, postalCode },
  timeZone,
});

export const TENANT_SPECS: TenantSpec[] = [
  {
    slug: "acme-field",
    name: "Acme Field Services",
    legalEntities: [
      { key: "A", name: "Acme Field Services A", legalName: "Acme Field Services Texas LLC" },
      { key: "B", name: "Acme Field Services B", legalName: "Acme Field Services Coastal LLC" },
    ],
    firstNames: ["Avery", "Blake", "Casey", "Dana", "Emerson", "Finley", "Harper", "Jordan", "Kendall", "Logan", "Morgan", "Parker"],
    lastNames: ["Alvarez", "Brooks", "Carter", "Diaz", "Ellis", "Foster", "Grant", "Hughes", "Ingram", "Jensen", "Keller", "Lopez"],
    units: [
      {
        key: "bu",
        type: "BUSINESS_UNIT",
        name: "Acme Operations",
        legalEntity: "A",
        children: [
          {
            key: "tx",
            type: "STATE",
            name: "Texas",
            legalEntity: "A",
            children: [
              {
                key: "tx-region",
                type: "REGION",
                name: "North Texas",
                legalEntity: "A",
                children: [
                  {
                    key: "tx-city",
                    type: "CITY",
                    name: "Dallas",
                    legalEntity: "A",
                    children: [
                      {
                        key: "tx-branch",
                        type: "BRANCH",
                        name: "Dallas Central",
                        legalEntity: "A",
                        ...branch("Dallas", "TX", "75201", "America/Chicago"),
                        children: [{ key: "tx-team", type: "TEAM", name: "Dallas Install Team", legalEntity: "A" }],
                      },
                    ],
                  },
                  {
                    key: "tx-city-2",
                    type: "CITY",
                    name: "Fort Worth",
                    legalEntity: "A",
                    children: [
                      { key: "tx-branch-2", type: "BRANCH", name: "Fort Worth Stockyards", legalEntity: "A", ...branch("Fort Worth", "TX", "76164", "America/Chicago") },
                    ],
                  },
                ],
              },
              {
                key: "tx-region-2",
                type: "REGION",
                name: "Gulf Coast",
                legalEntity: "A",
                children: [
                  {
                    key: "tx-city-3",
                    type: "CITY",
                    name: "Houston",
                    legalEntity: "A",
                    children: [
                      { key: "tx-branch-3", type: "BRANCH", name: "Houston Downtown", legalEntity: "A", ...branch("Houston", "TX", "77002", "America/Chicago") },
                    ],
                  },
                ],
              },
            ],
          },
          {
            key: "fl",
            type: "STATE",
            name: "Florida",
            legalEntity: "B",
            children: [
              {
                key: "fl-region",
                type: "REGION",
                name: "South Florida",
                legalEntity: "B",
                children: [
                  {
                    key: "fl-city",
                    type: "CITY",
                    name: "Miami",
                    legalEntity: "B",
                    children: [
                      {
                        key: "fl-branch",
                        type: "BRANCH",
                        name: "Miami Brickell",
                        legalEntity: "B",
                        ...branch("Miami", "FL", "33131", "America/New_York"),
                        children: [{ key: "fl-team", type: "TEAM", name: "Miami Service Team", legalEntity: "B" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            key: "ca",
            type: "STATE",
            name: "California",
            legalEntity: "B",
            children: [
              {
                key: "ca-region",
                type: "REGION",
                name: "Southern California",
                legalEntity: "B",
                children: [
                  {
                    key: "ca-city",
                    type: "CITY",
                    name: "Los Angeles",
                    legalEntity: "B",
                    children: [
                      {
                        key: "ca-branch",
                        type: "BRANCH",
                        name: "Los Angeles Westside",
                        legalEntity: "B",
                        ...branch("Los Angeles", "CA", "90025", "America/Los_Angeles"),
                        children: [{ key: "ca-team", type: "TEAM", name: "Westside Install Team", legalEntity: "B" }],
                      },
                    ],
                  },
                  {
                    key: "ca-city-2",
                    type: "CITY",
                    name: "San Diego",
                    legalEntity: "B",
                    children: [
                      { key: "ca-branch-2", type: "BRANCH", name: "San Diego Gaslamp", legalEntity: "B", ...branch("San Diego", "CA", "92101", "America/Los_Angeles") },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "globex-home",
    name: "Globex Home Services",
    legalEntities: [
      { key: "A", name: "Globex Home Services A", legalName: "Globex Home Services Inc." },
      { key: "B", name: "Globex Home Services B", legalName: "Globex Southeast LLC" },
    ],
    firstNames: ["Quinn", "Reese", "Sage", "Taylor", "Uma", "Val", "Wren", "Xander", "Yael", "Zion", "Arlo", "Briar"],
    lastNames: ["Nguyen", "Okafor", "Patel", "Quintero", "Reyes", "Singh", "Tran", "Underwood", "Vargas", "Whitfield", "Xu", "Young"],
    units: [
      {
        key: "bu",
        type: "BUSINESS_UNIT",
        name: "Globex Operations",
        legalEntity: "A",
        children: [
          {
            key: "tx",
            type: "STATE",
            name: "Texas",
            legalEntity: "A",
            children: [
              {
                key: "tx-region",
                type: "REGION",
                name: "Central Texas",
                legalEntity: "A",
                children: [
                  {
                    key: "tx-city",
                    type: "CITY",
                    name: "Austin",
                    legalEntity: "A",
                    children: [
                      {
                        key: "tx-branch",
                        type: "BRANCH",
                        name: "Austin Downtown",
                        legalEntity: "A",
                        ...branch("Austin", "TX", "78701", "America/Chicago"),
                        children: [{ key: "tx-team", type: "TEAM", name: "Austin Install Team", legalEntity: "A" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            key: "fl",
            type: "STATE",
            name: "Florida",
            legalEntity: "B",
            children: [
              {
                key: "fl-region",
                type: "REGION",
                name: "Central Florida",
                legalEntity: "B",
                children: [
                  {
                    key: "fl-city",
                    type: "CITY",
                    name: "Orlando",
                    legalEntity: "B",
                    children: [
                      { key: "fl-branch", type: "BRANCH", name: "Orlando Downtown", legalEntity: "B", ...branch("Orlando", "FL", "32801", "America/New_York") },
                    ],
                  },
                ],
              },
            ],
          },
          {
            key: "ca",
            type: "STATE",
            name: "California",
            legalEntity: "B",
            children: [
              {
                key: "ca-region",
                type: "REGION",
                name: "Bay Area",
                legalEntity: "B",
                children: [
                  {
                    key: "ca-city",
                    type: "CITY",
                    name: "San Jose",
                    legalEntity: "B",
                    children: [
                      { key: "ca-branch", type: "BRANCH", name: "San Jose Downtown", legalEntity: "B", ...branch("San Jose", "CA", "95113", "America/Los_Angeles") },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
