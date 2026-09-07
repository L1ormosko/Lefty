"use client";

import Link from "next/link";
import { useActionState } from "react";
import { forgotPasswordAction, type FormState } from "../actions";
import { t } from "@/lib/labels";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(forgotPasswordAction, undefined);

  if (state?.success) {
    return (
      <Card className="p-6">
        <Alert kind="success">{state.success}</Alert>
        <Link href="/login" className="mt-4 inline-block text-sm text-brand-600 hover:underline">
          {t("auth.backToLogin")}
        </Link>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold text-ink-900">{t("auth.forgotPasswordTitle")}</h1>
      <p className="mt-2 text-sm text-ink-600">{t("auth.forgotPasswordHint")}</p>
      <form action={action} className="mt-5 space-y-4">
        <Field label={t("auth.email")} htmlFor="email" required error={state?.fields?.email}>
          <input id="email" name="email" type="email" autoComplete="email" dir="ltr" required className={inputClass} />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? t("common.loading") : t("auth.sendResetLink")}
        </Button>
      </form>
      <Link href="/login" className="mt-4 inline-block text-sm text-brand-600 hover:underline">
        {t("auth.backToLogin")}
      </Link>
    </Card>
  );
}
