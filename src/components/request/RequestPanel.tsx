"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { createInquiryAction, type ActionState } from "@/app/actions/inquiries";
import { t } from "@/lib/labels";
import { CURRENCY, type AvailabilityState } from "@/lib/constants";
import { Alert, Button, Card, Field, Num, inputClass, textareaClass, cx } from "@/components/ui";
import { AvailabilityBadge } from "@/components/badges";

type Props = {
  assetId: string;
  title: string;
  priceLine: string | null;
  minimumBookingDays: number;
  instantBookable: boolean;
  availability: AvailabilityState;
  signedIn: boolean;
  defaults?: { contactName: string; contactEmail: string; contactPhone: string };
};

const today = new Date().toISOString().slice(0, 10);

export function RequestPanel({
  assetId,
  title,
  priceLine,
  minimumBookingDays,
  instantBookable,
  availability,
  signedIn,
  defaults,
}: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createInquiryAction, undefined);
  const [intent, setIntent] = useState<"AVAILABILITY" | "QUOTE" | "BOOKING">(
    instantBookable ? "BOOKING" : "AVAILABILITY"
  );
  const [start, setStart] = useState("");

  if (state?.ok) {
    return (
      <Card className="p-5">
        <Alert kind="success">{state.message}</Alert>
        <p className="mt-3 text-sm text-ink-600">{t("request.submittedHint")}</p>
        <Link href="/dashboard/requests" className="mt-3 inline-block text-sm text-brand-600 hover:underline">
          {t("dash.myRequests")} ←
        </Link>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-ink-900">{t("request.title")}</h2>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <AvailabilityBadge state={availability} size="sm" />
      </div>
      <p className="mt-2 text-lg font-semibold text-ink-900">
        {priceLine ? <Num>{priceLine}</Num> : <span className="text-base font-normal text-ink-600">{t("asset.priceNotPublished")}</span>}
      </p>
      <p className="text-xs text-ink-500 mt-1">
        {t("asset.minimumBooking")}: <Num>{minimumBookingDays}</Num> {t("asset.days")}
      </p>

      {!signedIn ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-ink-600">{t("auth.loginRequired")}</p>
          <Link
            href={`/login?next=${encodeURIComponent(`/assets/${assetId}`)}`}
            className="inline-flex items-center justify-center h-11 w-full rounded-md bg-brand-600 text-white font-medium hover:bg-brand-700"
          >
            {t("auth.login")}
          </Link>
          <Link href="/register" className="block text-center text-sm text-brand-600 hover:underline">
            {t("auth.register")}
          </Link>
        </div>
      ) : (
        <form action={action} className="mt-4 space-y-3">
          <input type="hidden" name="assetId" value={assetId} />
          <input type="hidden" name="intent" value={intent} />
          {state?.error && <Alert>{state.error}</Alert>}

          <fieldset>
            <legend className="text-sm font-medium text-ink-800 mb-1.5">{t("request.intent")}</legend>
            <div className="flex flex-wrap gap-1.5">
              {(["AVAILABILITY", "QUOTE", ...(instantBookable ? (["BOOKING"] as const) : [])] as const).map(
                (option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setIntent(option)}
                    aria-pressed={intent === option}
                    className={cx(
                      "px-3 h-8 rounded-md border text-sm",
                      intent === option
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-ink-200 text-ink-700 hover:bg-ink-50"
                    )}
                  >
                    {t(`intent.${option}`)}
                  </button>
                )
              )}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-2">
            <Field label={t("common.from")} htmlFor="startDate" required error={state?.fields?.startDate}>
              <input
                id="startDate"
                name="startDate"
                type="date"
                dir="ltr"
                required
                min={today}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field
              label={t("common.to")}
              htmlFor="endDate"
              required
              error={state?.fields?.endDate ? t(state.fields.endDate) : undefined}
            >
              <input
                id="endDate"
                name="endDate"
                type="date"
                dir="ltr"
                required
                min={start || today}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label={t("request.campaignName")} htmlFor="campaignName" required error={state?.fields?.campaignName}>
            <input id="campaignName" name="campaignName" required className={inputClass} />
          </Field>

          <Field label={`${t("request.budget")} (${CURRENCY})`} htmlFor="budget" hint={t("common.optional")}>
            <input id="budget" name="budget" type="number" min={0} dir="ltr" className={inputClass} />
          </Field>

          <Field label={t("request.message")} htmlFor="message" hint={t("common.optional")}>
            <textarea id="message" name="message" rows={3} className={textareaClass} />
          </Field>

          <fieldset className="space-y-3 border-t border-ink-200 pt-3">
            <legend className="sr-only">{t("request.contact")}</legend>
            <Field label={t("auth.name")} htmlFor="contactName" required error={state?.fields?.contactName}>
              <input
                id="contactName"
                name="contactName"
                required
                defaultValue={defaults?.contactName}
                className={inputClass}
              />
            </Field>
            <Field label={t("auth.email")} htmlFor="contactEmail" required error={state?.fields?.contactEmail}>
              <input
                id="contactEmail"
                name="contactEmail"
                type="email"
                dir="ltr"
                required
                defaultValue={defaults?.contactEmail}
                className={inputClass}
              />
            </Field>
            <Field label={t("auth.phone")} htmlFor="contactPhone" hint={t("common.optional")}>
              <input
                id="contactPhone"
                name="contactPhone"
                type="tel"
                dir="ltr"
                defaultValue={defaults?.contactPhone}
                className={inputClass}
              />
            </Field>
          </fieldset>

          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? t("common.loading") : t("common.submit")}
          </Button>
          <p className="text-xs text-ink-500">{t("asset.priceEstimateNote")}</p>
        </form>
      )}
    </Card>
  );
}
