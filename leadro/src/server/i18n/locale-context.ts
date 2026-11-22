import { withTenant } from "@/server/db";
import { activePlacementWhere } from "@/server/authz";
import {
  buildLocaleChain,
  directionOf,
  isValidTimeZone,
  type Locale,
  type TextDirection,
} from "@/lib/i18n";

export interface LocaleContext {
  /** Locale the interface is displayed in. */
  locale: Locale;
  /** Full fallback chain: user → branch → company → en-US (§16.2). */
  localeChain: Locale[];
  direction: TextDirection;
  /** IANA zone for displaying timestamps for this user (§16.5). */
  timeZone: string;
}

export interface LocaleContextRequest {
  userId?: string;
  /**
   * Branch to use when the user has no org assignment (e.g. a public page for a branch).
   * When omitted and `userId` is given, the user's current PRIMARY assignment is used.
   */
  orgUnitId?: string;
}

/** Org trees are shallow; the cap only protects against a (constraint-violating) parent cycle. */
const MAX_TREE_DEPTH = 32;

/**
 * Resolves language, direction and time zone for a request (§16.2, §16.5).
 * "Branch" means the nearest org unit at or above the user's primary placement that sets a value.
 */
export async function resolveLocaleContext(
  tenantId: string,
  request: LocaleContextRequest = {},
): Promise<LocaleContext> {
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { defaultLocale: true, defaultTimeZone: true },
    });
    const user = request.userId
      ? await tx.user.findFirst({
          where: { id: request.userId, tenantId },
          select: { locale: true, timeZone: true },
        })
      : null;

    const startUnitId = request.orgUnitId ?? (request.userId ? await primaryOrgUnitId(tx, tenantId, request.userId) : null);
    const branch = { locale: null as string | null, timeZone: null as string | null };
    let nextUnitId = startUnitId;
    for (let depth = 0; nextUnitId && depth < MAX_TREE_DEPTH; depth++) {
      const unit = await tx.orgUnit.findFirst({
        where: { id: nextUnitId, tenantId },
        select: { parentId: true, defaultLocale: true, timeZone: true },
      });
      if (!unit) break;
      branch.locale ??= unit.defaultLocale;
      branch.timeZone ??= unit.timeZone;
      if (branch.locale && branch.timeZone) break;
      nextUnitId = unit.parentId;
    }

    const localeChain = buildLocaleChain({
      user: user?.locale,
      branch: branch.locale,
      company: tenant.defaultLocale,
    });
    const timeZone =
      [user?.timeZone, branch.timeZone, tenant.defaultTimeZone].find(
        (zone): zone is string => typeof zone === "string" && isValidTimeZone(zone),
      ) ?? "UTC";
    return { locale: localeChain[0], localeChain, direction: directionOf(localeChain[0]), timeZone };
  });
}

async function primaryOrgUnitId(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const now = new Date();
  const assignment = await tx.organizationalAssignment.findFirst({
    where: {
      tenantId,
      kind: "PRIMARY",
      employee: { userId, tenantId },
      ...activePlacementWhere(now),
    },
    orderBy: { effectiveFrom: "desc" },
    select: { orgUnitId: true },
  });
  return assignment?.orgUnitId ?? null;
}
