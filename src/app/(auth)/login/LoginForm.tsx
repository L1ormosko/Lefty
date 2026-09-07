"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, type FormState } from "../actions";
import { t } from "@/lib/labels";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, undefined);

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold text-ink-900">{t("auth.login")}</h1>
      <form action={action} className="mt-5 space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        {state?.error && <Alert>{state.error}</Alert>}
        <Field label={t("auth.email")} htmlFor="email" required error={state?.fields?.email}>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            dir="ltr"
            required
            className={inputClass}
          />
        </Field>
        <Field label={t("auth.password")} htmlFor="password" required error={state?.fields?.password}>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
            className={inputClass}
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? t("common.loading") : t("auth.login")}
        </Button>
      </form>
      <p className="mt-3 text-sm">
        <Link href="/forgot-password" className="text-brand-600 hover:underline">
          {t("nav.forgotPassword")}
        </Link>
      </p>
      <p className="mt-4 text-sm text-ink-600">
        {t("auth.noAccount")}{" "}
        <Link href="/register" className="text-brand-600 hover:underline">
          {t("auth.register")}
        </Link>
      </p>
    </Card>
  );
}
