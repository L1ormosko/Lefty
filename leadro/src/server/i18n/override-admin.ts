import { recordAudit, auditContextFields } from "@/server/audit";
import { assertNotSelfApproval, canInTx } from "@/server/authz";
import {
  pageArgs,
  toPage,
  type Page,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type Actor,
  type AppError,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { CATALOGS, isSupportedLocale } from "@/lib/i18n";
import {
  deleteOverrideInTx,
  markOverrideReviewedInTx,
  saveOverrideInTx,
  TranslationOverrideError,
} from "./overrides";

/**
 * Permissions (decided in Task 5): editing a text needs `localization.edit`, approving or removing
 * a text needs `localization.configure`. Two different permissions keep the §16.6 review step
 * meaningful: the default Owner holds both, but a tenant can give "edit" to translators and
 * "configure" only to a reviewer. Translations belong to the tenant as a whole, so a TENANT scope
 * is required.
 */
const EDIT_PERMISSION = "localization.edit";
const REVIEW_PERMISSION = "localization.configure";

/** Maps the module's local error type to the core AppError hierarchy the API layer understands. */
export function toAppError(error: TranslationOverrideError): AppError {
  switch (error.code) {
    case "NOT_FOUND":
      return new NotFoundError({ message: error.message, cause: error });
    case "CONFLICT":
      return new ConflictError({ message: error.message, cause: error });
    case "UNSUPPORTED_LOCALE":
      return new ValidationError({ message: error.message, field: "locale", cause: error });
    case "UNKNOWN_KEY":
      return new ValidationError({ message: error.message, field: "key", cause: error });
    case "PLACEHOLDER_MISMATCH":
      return new ValidationError({ message: error.message, field: "value", cause: error });
  }
}

async function assertMay(tx: TenantTx, actor: Actor, permission: string): Promise<void> {
  // `{}` = a tenant-level record: only a TENANT-scoped grant matches.
  if (!(await canInTx(tx, actor, permission, {})).allowed) throw new ForbiddenError();
}

/** Runs a translation write, converting `TranslationOverrideError` to an `AppError`. */
async function run<T>(actor: Actor, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(actor.tenantId, work);
  } catch (error) {
    throw error instanceof TranslationOverrideError ? toAppError(error) : error;
  }
}

/**
 * Creates or changes a tenant translation override on behalf of `actor` (needs `localization.edit`).
 * The text always lands UNREVIEWED and is not served until someone reviews it. Audited as
 * `translation.save` with the previous and new text, in the same transaction.
 */
export async function saveOverrideAsActor(
  actor: Actor,
  ctx: RequestContext,
  input: { locale: string; key: string; value: string },
): Promise<{ id: string }> {
  return run(actor, async (tx) => {
    await assertMay(tx, actor, EDIT_PERMISSION);
    const before = await tx.translationResource.findFirst({
      where: { tenantId: actor.tenantId, locale: input.locale, key: input.key },
      select: { value: true, reviewed: true },
    });
    const saved = await saveOverrideInTx(tx, actor.tenantId, { ...input, editorUserId: actor.userId });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "translation.save",
      targetType: "TranslationResource",
      targetId: saved.id,
      previousValue: before ?? undefined,
      newValue: { locale: input.locale, key: input.key, value: input.value, reviewed: false },
    });
    return saved;
  });
}

/**
 * Approves an override (needs `localization.configure`). The approval is bound to the text the
 * reviewer read (`reviewedValue`); a concurrent edit makes it a CONFLICT. Audited as `translation.review`.
 */
export async function reviewOverrideAsActor(
  actor: Actor,
  ctx: RequestContext,
  input: { locale: string; key: string; reviewedValue: string },
): Promise<void> {
  await run(actor, async (tx) => {
    await assertMay(tx, actor, REVIEW_PERMISSION);
    // Separation of duties (§21.3, §16.6): the last editor of a text cannot be the one who approves it.
    const stored = await tx.translationResource.findFirst({
      where: { tenantId: actor.tenantId, locale: input.locale, key: input.key },
      select: { updatedById: true },
    });
    if (stored) assertNotSelfApproval(actor.userId, stored.updatedById);
    await markOverrideReviewedInTx(tx, actor.tenantId, { ...input, reviewerUserId: actor.userId });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "translation.review",
      targetType: "TranslationResource",
      targetId: `${input.locale}:${input.key}`,
      newValue: { locale: input.locale, key: input.key, value: input.reviewedValue, reviewed: true },
    });
  });
}

/**
 * Removes an override so the built-in text is used again (needs `localization.configure`, because
 * it silently changes what users see). Audited as `translation.delete`.
 */
export async function deleteOverrideAsActor(
  actor: Actor,
  ctx: RequestContext,
  input: { locale: string; key: string },
): Promise<void> {
  await run(actor, async (tx) => {
    await assertMay(tx, actor, REVIEW_PERMISSION);
    const removed = await deleteOverrideInTx(tx, actor.tenantId, input);
    if (removed === 0) throw new NotFoundError({ message: "No such translation override" });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "translation.delete",
      targetType: "TranslationResource",
      targetId: `${input.locale}:${input.key}`,
      previousValue: input,
    });
  });
}

/** One override as the admin screen shows it, next to the built-in text it replaces. */
export interface OverrideView {
  id: string;
  locale: string;
  key: string;
  value: string;
  /** The built-in catalog text for the same locale and key (null if the key no longer exists). */
  builtIn: string | null;
  reviewed: boolean;
  /** Who last edited it; a reviewer cannot be this person (separation of duties). */
  updatedById: string | null;
  updatedAt: Date;
}

/**
 * Overrides of the tenant (needs `localization.view`, tenant-level), newest edit first, optionally
 * filtered by locale and review state. Reads through `withTenant`, so RLS keeps tenants apart.
 */
export async function listOverridesAsActor(
  actor: Actor,
  query: { cursor?: string; limit: number; locale?: string; reviewed?: boolean },
): Promise<Page<OverrideView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await assertMay(tx, actor, "localization.view");
    const rows = await tx.translationResource.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(query.locale ? { locale: query.locale } : {}),
        ...(query.reviewed === undefined ? {} : { reviewed: query.reviewed }),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        locale: row.locale,
        key: row.key,
        value: row.value,
        builtIn: isSupportedLocale(row.locale) ? (CATALOGS[row.locale].messages[row.key] ?? null) : null,
        reviewed: row.reviewed,
        updatedById: row.updatedById,
        updatedAt: row.updatedAt,
      })),
      page: page.page,
    };
  });
}
