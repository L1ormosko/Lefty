"use client";

import { useActionState, useState } from "react";
import {
  changePasswordAction,
  deleteAccountAction,
  updateProfileAction,
} from "@/app/actions/account";
import type { ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { Alert, Button, Card, Field, buttonClass, inputClass } from "@/components/ui";

export type AccountData = {
  name: string;
  email: string;
  phone: string | null;
  roleLabel: string;
  company: {
    name: string;
    contactEmail: string;
    contactPhone: string | null;
    website: string | null;
    businessId: string | null;
  } | null;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      {hint && <p className="mt-1 text-sm text-ink-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function Result({ state }: { state: ActionState }) {
  if (!state) return null;
  if (state.ok) return <Alert kind="success">{state.message}</Alert>;
  if (state.error) return <Alert>{state.error}</Alert>;
  return null;
}

/** Details, company, password, export and deletion - the whole account surface. */
export function AccountForms({ data, deletionBlocked }: { data: AccountData; deletionBlocked: string | null }) {
  return (
    <div className="space-y-4 max-w-2xl">
      <ProfileForm data={data} />
      <PasswordForm />
      <ExportPanel />
      <DeletePanel blocked={deletionBlocked} />
    </div>
  );
}

function ProfileForm({ data }: { data: AccountData }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateProfileAction, undefined);
  const err = (k: string) => (state && !state.ok ? state.fields?.[k] : undefined);

  return (
    <form action={action} className="space-y-4">
      <Section title={t("account.details")} hint={t("account.detailsHint")}>
        <div className="space-y-4">
          <Result state={state} />
          <Field label={t("auth.name")} htmlFor="name" required error={err("name")}>
            <input id="name" name="name" defaultValue={data.name} required className={inputClass} />
          </Field>
          <Field label={t("auth.phone")} htmlFor="phone" error={err("phone")}>
            <input id="phone" name="phone" dir="ltr" defaultValue={data.phone ?? ""} className={inputClass} />
          </Field>
          {/* Email is the login identity: changing it needs a verification step
              this product does not have, so it is shown rather than edited. */}
          <Field label={t("auth.email")} htmlFor="email-readonly" hint={t("account.emailLocked")}>
            <input
              id="email-readonly"
              dir="ltr"
              value={data.email}
              readOnly
              className={`${inputClass} bg-ink-50 text-ink-500`}
            />
          </Field>
          <Field label={t("auth.role")} htmlFor="role-readonly">
            <input id="role-readonly" value={data.roleLabel} readOnly className={`${inputClass} bg-ink-50 text-ink-500`} />
          </Field>
        </div>
      </Section>

      <Section title={t("account.company")} hint={t("account.companyHint")}>
        <div className="space-y-4">
          <Field label={t("auth.companyName")} htmlFor="companyName" error={err("companyName")}>
            <input
              id="companyName"
              name="companyName"
              defaultValue={data.company?.name ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="דוא״ל ליצירת קשר" htmlFor="companyEmail" error={err("companyEmail")}>
            <input
              id="companyEmail"
              name="companyEmail"
              type="email"
              dir="ltr"
              defaultValue={data.company?.contactEmail ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="טלפון ליצירת קשר" htmlFor="companyPhone" error={err("companyPhone")}>
            <input
              id="companyPhone"
              name="companyPhone"
              dir="ltr"
              defaultValue={data.company?.contactPhone ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="אתר אינטרנט" htmlFor="companyWebsite" error={err("companyWebsite")}>
            <input
              id="companyWebsite"
              name="companyWebsite"
              dir="ltr"
              placeholder="https://"
              defaultValue={data.company?.website ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="ח.פ / עוסק מורשה" htmlFor="businessId" error={err("businessId")}>
            <input
              id="businessId"
              name="businessId"
              dir="ltr"
              defaultValue={data.company?.businessId ?? ""}
              className={inputClass}
            />
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.loading") : t("common.save")}
          </Button>
        </div>
      </Section>
    </form>
  );
}

function PasswordForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(changePasswordAction, undefined);
  const err = (k: string) => (state && !state.ok ? state.fields?.[k] : undefined);

  return (
    <Section title={t("account.password")} hint={t("account.passwordHint")}>
      <form action={action} className="space-y-4">
        <Result state={state} />
        <Field
          label={t("account.currentPassword")}
          htmlFor="currentPassword"
          required
          error={err("currentPassword")}
        >
          <input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
            className={inputClass}
          />
        </Field>
        <Field label={t("account.newPassword")} htmlFor="password" required error={err("password")}>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            required
            className={inputClass}
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? t("common.loading") : t("account.changePassword")}
        </Button>
      </form>
    </Section>
  );
}

function ExportPanel() {
  return (
    <Section title={t("account.export")} hint={t("account.exportHint")}>
      {/* A plain link, not fetch(): the browser's own download handling is what
          turns the response into a saved file. */}
      <a href="/api/account/export" className={buttonClass("secondary")}>
        {t("account.exportAction")}
      </a>
    </Section>
  );
}

function DeletePanel({ blocked }: { blocked: string | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(deleteAccountAction, undefined);
  const [open, setOpen] = useState(false);
  const err = (k: string) => (state && !state.ok ? state.fields?.[k] : undefined);

  return (
    <Card className="p-5 border-bad-500/30">
      <h2 className="text-base font-semibold text-bad-700">{t("account.danger")}</h2>
      <p className="mt-1 text-sm text-ink-600">{t("account.dangerHint")}</p>

      {blocked ? (
        <div className="mt-4">
          <Alert kind="info">{blocked}</Alert>
        </div>
      ) : !open ? (
        <Button variant="secondary" className="mt-4" onClick={() => setOpen(true)}>
          {t("account.danger")}
        </Button>
      ) : (
        <form action={action} className="mt-4 space-y-4">
          <Result state={state} />
          <Field
            label={t("account.currentPassword")}
            htmlFor="del-password"
            required
            error={err("currentPassword")}
          >
            <input
              id="del-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              dir="ltr"
              required
              className={inputClass}
            />
          </Field>
          <Field label={t("account.confirmWord")} htmlFor="del-confirm" required error={err("confirm")}>
            <input id="del-confirm" name="confirm" required className={inputClass} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? t("common.loading") : t("account.deleteAction")}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
