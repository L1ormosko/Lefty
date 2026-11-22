import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import type { MessageKey, TranslateFn } from "@/lib/i18n";
import type { ClientInfo } from "@/server/auth";
import { recordAuthzDenial } from "@/server/authz";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import type { FormState } from "../../../_lib/form-state";
import { messageForError } from "../../../_lib/action-errors";
import { requireFullSession, type PageContext } from "../../../_lib/page-context";
import { getClientInfo } from "../../../_lib/request-client";

/**
 * Shared plumbing of the administration server actions. An action is: authenticate (full session,
 * re-read on every call, never trusting the hidden UI), parse the form with the SAME Zod schema
 * the /api/v1 route uses, call ONE service function (which enforces permission + data scope),
 * and turn a thrown AppError into a translated message. No business rule lives here.
 */

/** What an action body receives: the verified caller and the request facts services audit. */
export interface AdminActionContext extends PageContext {
  actor: Actor;
  ctx: RequestContext;
  /** Client facts (IP, user agent) for services that take `ClientInfo` instead of a request context. */
  client: ClientInfo;
}

/** `validation field -> message` for problems the user can fix; any other code uses the generic text. */
const FIELD_ERROR_KEYS: Record<string, MessageKey> = {
  name: "ADMIN.ERROR_FIELD_NAME",
  newParentId: "ADMIN.ERROR_FIELD_NEW_PARENT",
  parentId: "ADMIN.ERROR_FIELD_PARENT",
  legalEntityId: "ADMIN.ERROR_FIELD_LEGAL_ENTITY",
  employeeNumber: "ADMIN.ERROR_FIELD_EMPLOYEE_NUMBER",
  email: "ADMIN.ERROR_FIELD_EMAIL",
  reason: "ADMIN.ERROR_FIELD_REASON",
  effectiveFrom: "ADMIN.ERROR_FIELD_EFFECTIVE_FROM",
  effectiveTo: "ADMIN.ERROR_FIELD_EFFECTIVE_TO",
  terminationDate: "ADMIN.ERROR_FIELD_TERMINATION_DATE",
  value: "ADMIN.ERROR_FIELD_VALUE",
  key: "ADMIN.ERROR_FIELD_KEY",
  locale: "ADMIN.ERROR_FIELD_LOCALE",
  postalCode: "ADMIN.ERROR_FIELD_POSTAL_CODE",
};

/**
 * Translated, non-revealing text for a failed action: the shared `messageForError` with this
 * module's field texts and the shared per-code defaults.
 */
export function adminErrorMessage(error: unknown, t: TranslateFn): string {
  return messageForError(error, t, {}, { byField: FIELD_ERROR_KEYS, useDefaults: true });
}

/** Form values as a plain object; blank inputs become `undefined` so optional schema fields stay optional. */
export function formValues(formData: FormData): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    values[key] = trimmed === "" ? undefined : trimmed;
  }
  return values;
}

/** Parses with a service schema; the first problem becomes a ValidationError naming its field. */
export function parseWith<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ValidationError({ message: issue?.message ?? "Invalid input.", field: issue?.path.join(".") || undefined });
}

export interface AdminActionOptions {
  /** Paths whose server-rendered data changed and must be re-fetched. */
  revalidate: string[];
  /** Runs the service call(s). Returns the translated success text. */
  run: (context: AdminActionContext, formData: FormData) => Promise<string>;
}

/**
 * Runs one administration action end to end and returns the `FormState` a form shows. Only
 * AppErrors become messages; anything else is logged and shown as the generic internal error.
 */
export async function runAdminAction(formData: FormData, options: AdminActionOptions): Promise<FormState> {
  const page = await requireFullSession();
  const client = await getClientInfo();
  const context: AdminActionContext = {
    ...page,
    client,
    ctx: { correlationId: client.correlationId ?? randomUUID(), actor: page.actor, sourceApp: "WEB" },
  };
  try {
    const success = await options.run(context, formData);
    for (const path of options.revalidate) revalidatePath(path);
    return { success };
  } catch (error) {
    // The enforcement helpers inside services stay silent, so refusals of web actions are audited here.
    if (error instanceof ForbiddenError || error instanceof NotFoundError) await recordAuthzDenial(page.actor, null, context.ctx);
    return { error: adminErrorMessage(error, page.t) };
  }
}

/**
 * Runs a service call whose only possible CONFLICT is a duplicate of one named field (a unique
 * column), and labels it so the user sees "this number is already used" instead of the generic
 * "changed by someone else" text.
 */
export async function withConflictField<T>(field: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ConflictError && !error.field) throw new ConflictError({ message: error.message, field, cause: error });
    throw error;
  }
}
