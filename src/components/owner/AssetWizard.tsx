"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addAvailabilityPeriodAction,
  deleteAvailabilityPeriodAction,
  publishAssetAction,
  saveAssetBasicsAction,
  saveAssetLocationAction,
  saveAssetPricingAction,
  saveAssetSpecsAction,
  type AssetActionState,
} from "@/app/actions/assets";
import { ASSET_TYPES, CURRENCY, ILLUMINATIONS, LOCATION_TAGS, PERMIT_STATUSES } from "@/lib/constants";
import { t } from "@/lib/labels";
import { formatRange } from "@/lib/dates";
import { Alert, Button, Card, Field, Num, cx, inputClass, textareaClass } from "@/components/ui";
import { LocationPicker } from "./LocationPicker";
import { ImageUploader } from "./ImageUploader";

export type WizardAsset = {
  id: string;
  title: string;
  description: string | null;
  assetType: string;
  address: string;
  city: string;
  region: string | null;
  latitude: number;
  longitude: number;
  widthCm: number | null;
  heightCm: number | null;
  orientation: string | null;
  sides: number;
  illumination: string;
  isDigital: boolean;
  permitStatus: string;
  locationTags: string[];
  priceWeekly: number | null;
  priceMonthly: number | null;
  minimumBookingDays: number;
  productionIncluded: boolean;
  installationIncluded: boolean;
  removalIncluded: boolean;
  instantBookable: boolean;
  status: string;
  images: { id: string; url: string; isPrimary: boolean }[];
  periods: { id: string; startDate: Date; endDate: Date; note: string | null }[];
};

const STEPS = ["basic", "location", "specs", "pricing", "availability", "images", "review"] as const;
type Step = (typeof STEPS)[number];

export function AssetWizard({ asset }: { asset: WizardAsset | null }) {
  const router = useRouter();
  const [assetId, setAssetId] = useState(asset?.id ?? "");
  const [step, setStep] = useState<Step>("basic");
  const index = STEPS.indexOf(step);

  function goNext() {
    setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]);
  }

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-1.5" aria-label={t("wizard.step")}>
        {STEPS.map((s, i) => {
          const reachable = !!assetId || i === 0;
          return (
            <li key={s}>
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && setStep(s)}
                aria-current={s === step ? "step" : undefined}
                className={cx(
                  "rounded-md px-2.5 h-8 text-xs border",
                  s === step
                    ? "bg-ink-900 text-white border-ink-900"
                    : reachable
                      ? "bg-white text-ink-700 border-ink-200 hover:bg-ink-50"
                      : "bg-ink-50 text-ink-400 border-ink-200 cursor-not-allowed"
                )}
              >
                <Num>{i + 1}</Num>. {t(`wizard.${s}`)}
              </button>
            </li>
          );
        })}
      </ol>

      <Card className="p-5">
        {step === "basic" && (
          <BasicStep asset={asset} assetId={assetId} onSaved={(id) => { setAssetId(id); goNext(); }} />
        )}
        {step === "location" && assetId && (
          <LocationStep asset={asset} assetId={assetId} onSaved={goNext} />
        )}
        {step === "specs" && assetId && <SpecsStep asset={asset} assetId={assetId} onSaved={goNext} />}
        {step === "pricing" && assetId && <PricingStep asset={asset} assetId={assetId} onSaved={goNext} />}
        {step === "availability" && assetId && (
          <AvailabilityStep assetId={assetId} periods={asset?.periods ?? []} onNext={goNext} />
        )}
        {step === "images" && assetId && (
          <div className="space-y-4">
            <h2 className="font-semibold text-ink-900">{t("wizard.images")}</h2>
            <ImageUploader assetId={assetId} initial={asset?.images ?? []} />
            <Button onClick={goNext}>{t("common.next")}</Button>
          </div>
        )}
        {step === "review" && assetId && (
          <ReviewStep assetId={assetId} asset={asset} onPublished={() => router.push("/owner/assets")} />
        )}
      </Card>
    </div>
  );
}

function useStepAction(
  action: (prev: AssetActionState, fd: FormData) => Promise<AssetActionState>,
  onSaved: (id: string) => void
) {
  const [state, formAction, pending] = useActionState<AssetActionState, FormData>(async (prev, fd) => {
    const result = await action(prev, fd);
    if (result?.ok) onSaved(result.assetId);
    return result;
  }, undefined);
  return { state, formAction, pending };
}

function StepFooter({ pending, label }: { pending: boolean; label?: string }) {
  return (
    <div className="pt-2">
      <Button type="submit" disabled={pending}>
        {pending ? t("common.loading") : (label ?? t("common.next"))}
      </Button>
    </div>
  );
}

function BasicStep({
  asset,
  assetId,
  onSaved,
}: {
  asset: WizardAsset | null;
  assetId: string;
  onSaved: (id: string) => void;
}) {
  const { state, formAction, pending } = useStepAction(saveAssetBasicsAction, onSaved);
  return (
    <form action={formAction} className="space-y-4">
      <h2 className="font-semibold text-ink-900">{t("wizard.basic")}</h2>
      {assetId && <input type="hidden" name="assetId" value={assetId} />}
      {state?.ok === false && state.error && <Alert>{state.error}</Alert>}
      <Field label="שם השטח" htmlFor="title" required error={state?.ok === false ? state.fields?.title : undefined}>
        <input id="title" name="title" required defaultValue={asset?.title} className={inputClass} />
      </Field>
      <Field label={t("filter.assetType")} htmlFor="assetType" required>
        <select id="assetType" name="assetType" defaultValue={asset?.assetType ?? "BILLBOARD"} className={inputClass}>
          {ASSET_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`type.${type}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="תיאור" htmlFor="description" hint={t("common.optional")}>
        <textarea id="description" name="description" rows={4} defaultValue={asset?.description ?? ""} className={textareaClass} />
      </Field>
      <StepFooter pending={pending} label={assetId ? t("common.next") : t("wizard.saveAndContinue")} />
    </form>
  );
}

function LocationStep({ asset, assetId, onSaved }: { asset: WizardAsset | null; assetId: string; onSaved: () => void }) {
  const { state, formAction, pending } = useStepAction(saveAssetLocationAction, onSaved);
  return (
    <form action={formAction} className="space-y-4">
      <h2 className="font-semibold text-ink-900">{t("wizard.location")}</h2>
      <input type="hidden" name="assetId" value={assetId} />
      {state?.ok === false && state.error && <Alert>{state.error}</Alert>}
      <Field label="כתובת" htmlFor="address" required error={state?.ok === false ? state.fields?.address : undefined}>
        <input id="address" name="address" required defaultValue={asset?.address} className={inputClass} />
      </Field>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label={t("filter.city")} htmlFor="city" required error={state?.ok === false ? state.fields?.city : undefined}>
          <input id="city" name="city" required defaultValue={asset?.city} className={inputClass} />
        </Field>
        <Field label="אזור" htmlFor="region" hint={t("common.optional")}>
          <input id="region" name="region" defaultValue={asset?.region ?? ""} className={inputClass} />
        </Field>
      </div>
      {state?.ok === false && (state.fields?.latitude || state.fields?.longitude) && (
        <Alert>{state.fields.latitude ?? state.fields.longitude}</Alert>
      )}
      <LocationPicker
        latitude={asset?.latitude}
        longitude={asset?.longitude}
        onChange={() => {}}
      />
      <StepFooter pending={pending} />
    </form>
  );
}

function SpecsStep({ asset, assetId, onSaved }: { asset: WizardAsset | null; assetId: string; onSaved: () => void }) {
  const { state, formAction, pending } = useStepAction(saveAssetSpecsAction, onSaved);
  return (
    <form action={formAction} className="space-y-4">
      <h2 className="font-semibold text-ink-900">{t("wizard.specs")}</h2>
      <input type="hidden" name="assetId" value={assetId} />
      {state?.ok === false && state.error && <Alert>{state.error}</Alert>}
      <p className="text-sm text-ink-500">שדות שלא ימולאו יוצגו כ״{t("common.notProvided")}״ ולא יומצאו.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="רוחב (ס״מ)" htmlFor="widthCm" hint={t("common.optional")}>
          <input id="widthCm" name="widthCm" type="number" min={1} dir="ltr" defaultValue={asset?.widthCm ?? ""} className={inputClass} />
        </Field>
        <Field label="גובה (ס״מ)" htmlFor="heightCm" hint={t("common.optional")}>
          <input id="heightCm" name="heightCm" type="number" min={1} dir="ltr" defaultValue={asset?.heightCm ?? ""} className={inputClass} />
        </Field>
        <Field label={t("asset.orientation")} htmlFor="orientation" hint={t("common.optional")}>
          <input id="orientation" name="orientation" defaultValue={asset?.orientation ?? ""} className={inputClass} />
        </Field>
        <Field label={t("asset.sides")} htmlFor="sides">
          <input id="sides" name="sides" type="number" min={1} max={8} dir="ltr" defaultValue={asset?.sides ?? 1} className={inputClass} />
        </Field>
        <Field label={t("asset.illumination")} htmlFor="illumination">
          <select id="illumination" name="illumination" defaultValue={asset?.illumination ?? "UNKNOWN"} className={inputClass}>
            {ILLUMINATIONS.map((i) => (
              <option key={i} value={i}>
                {t(`illum.${i}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("asset.permit")} htmlFor="permitStatus" hint={t("permit.note")}>
          <select id="permitStatus" name="permitStatus" defaultValue={asset?.permitStatus ?? "UNKNOWN"} className={inputClass}>
            {PERMIT_STATUSES.map((p) => (
              <option key={p} value={p}>
                {t(`permit.${p}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" name="isDigital" defaultChecked={asset?.isDigital} className="size-4 rounded border-ink-300" />
        {t("asset.digital")}
      </label>

      {/*
        Surroundings, declared by the owner. The hint is not decoration: this
        is the closest VELTO gets to "who sees this billboard", and an owner
        who thinks they are filling in an audience figure will fill it in
        wrongly. We measure nothing, and the advertiser is told the same.
      */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-800">{t("tag.sectionTitle")}</legend>
        <p className="text-xs text-ink-500">{t("tag.ownerHelp")}</p>
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
          {LOCATION_TAGS.map((tag) => (
            <label key={tag} className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                name="locationTags"
                value={tag}
                defaultChecked={asset?.locationTags?.includes(tag)}
                className="size-4 rounded border-ink-300"
              />
              {t(`tag.${tag}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <StepFooter pending={pending} />
    </form>
  );
}

function PricingStep({ asset, assetId, onSaved }: { asset: WizardAsset | null; assetId: string; onSaved: () => void }) {
  const { state, formAction, pending } = useStepAction(saveAssetPricingAction, onSaved);
  return (
    <form action={formAction} className="space-y-4">
      <h2 className="font-semibold text-ink-900">{t("wizard.pricing")}</h2>
      <input type="hidden" name="assetId" value={assetId} />
      {state?.ok === false && state.error && <Alert>{state.error}</Alert>}
      <p className="text-sm text-ink-500">
        מחיר שלא יפורסם יוצג כ״{t("asset.priceNotPublished")}״.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label={`${t("asset.priceWeekly")} (${CURRENCY})`} htmlFor="priceWeekly" hint={t("common.optional")}>
          <input id="priceWeekly" name="priceWeekly" type="number" min={0} dir="ltr" defaultValue={asset?.priceWeekly ?? ""} className={inputClass} />
        </Field>
        <Field label={`${t("asset.priceMonthly")} (${CURRENCY})`} htmlFor="priceMonthly" hint={t("common.optional")}>
          <input id="priceMonthly" name="priceMonthly" type="number" min={0} dir="ltr" defaultValue={asset?.priceMonthly ?? ""} className={inputClass} />
        </Field>
        <Field label={`${t("asset.minimumBooking")} (${t("asset.days")})`} htmlFor="minimumBookingDays">
          <input id="minimumBookingDays" name="minimumBookingDays" type="number" min={1} dir="ltr" defaultValue={asset?.minimumBookingDays ?? 7} className={inputClass} />
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-800 mb-1">{t("asset.extras")}</legend>
        {(
          [
            ["productionIncluded", t("asset.production"), asset?.productionIncluded],
            ["installationIncluded", t("asset.installation"), asset?.installationIncluded],
            ["removalIncluded", t("asset.removal"), asset?.removalIncluded],
          ] as const
        ).map(([name, label, checked]) => (
          <label key={name} className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" name={name} defaultChecked={!!checked} className="size-4 rounded border-ink-300" />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-2 text-sm text-ink-700 border-t border-ink-200 pt-3">
        <input type="checkbox" name="instantBookable" defaultChecked={asset?.instantBookable} className="size-4 rounded border-ink-300 mt-0.5" />
        <span>
          {t("asset.requestBooking")}
          <span className="block text-xs text-ink-500">מפרסמים יוכלו לשלוח בקשת הזמנה לתאריכים, שתמתין לאישורכם.</span>
        </span>
      </label>
      <StepFooter pending={pending} />
    </form>
  );
}

function AvailabilityStep({
  assetId,
  periods,
  onNext,
}: {
  assetId: string;
  periods: WizardAsset["periods"];
  onNext: () => void;
}) {
  const [state, formAction, pending] = useActionState<AssetActionState, FormData>(
    addAvailabilityPeriodAction,
    undefined
  );
  const [list, setList] = useState(periods);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-ink-900">{t("wizard.availability")}</h2>
      <p className="text-sm text-ink-500">
        הגדירו את החלונות שבהם השטח פנוי למכירה. ללא חלון זמינות, השטח יוצג כתפוס.
      </p>

      {list.length > 0 && (
        <ul className="space-y-2">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-3 text-sm bg-ink-50 border border-ink-200 rounded p-2">
              <Num>{formatRange(p.startDate, p.endDate)}</Num>
              {p.note && <span className="text-ink-500">{p.note}</span>}
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto"
                onClick={async () => {
                  await deleteAvailabilityPeriodAction(p.id);
                  setList((prev) => prev.filter((x) => x.id !== p.id));
                }}
              >
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form action={formAction} className="space-y-3 border-t border-ink-200 pt-4">
        <input type="hidden" name="assetId" value={assetId} />
        {state?.ok === false && state.error && <Alert>{state.error}</Alert>}
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label={t("common.from")} htmlFor="startDate" required>
            <input id="startDate" name="startDate" type="date" dir="ltr" required className={inputClass} />
          </Field>
          <Field
            label={t("common.to")}
            htmlFor="endDate"
            required
            error={state?.ok === false && state.fields?.endDate ? t(state.fields.endDate) : undefined}
          >
            <input id="endDate" name="endDate" type="date" dir="ltr" required className={inputClass} />
          </Field>
        </div>
        <Field label="הערה" htmlFor="note" hint={t("common.optional")}>
          <input id="note" name="note" className={inputClass} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? t("common.loading") : "הוספת חלון"}
          </Button>
          <Button type="button" onClick={onNext}>
            {t("common.next")}
          </Button>
        </div>
        {state?.ok && <p className="text-sm text-ok-700">נשמר. רעננו את הדף כדי לראות את הרשימה המעודכנת.</p>}
      </form>
    </div>
  );
}

function ReviewStep({
  assetId,
  asset,
  onPublished,
}: {
  assetId: string;
  asset: WizardAsset | null;
  onPublished: () => void;
}) {
  const [state, formAction, pending] = useActionState<AssetActionState, FormData>(async (prev, fd) => {
    const result = await publishAssetAction(prev, fd);
    if (result?.ok) setTimeout(onPublished, 1200);
    return result;
  }, undefined);

  return (
    <form action={formAction} className="space-y-4">
      <h2 className="font-semibold text-ink-900">{t("wizard.review")}</h2>
      <input type="hidden" name="assetId" value={assetId} />
      {state?.ok === false && state.error && <Alert>{state.error}</Alert>}
      {state?.ok && <Alert kind="success">{state.message}</Alert>}
      <dl className="text-sm space-y-1.5">
        <div className="flex gap-3">
          <dt className="w-28 text-ink-500">שם</dt>
          <dd>{asset?.title ?? "—"}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 text-ink-500">{t("asset.location")}</dt>
          <dd>{asset ? `${asset.address}, ${asset.city}` : "—"}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 text-ink-500">{t("wizard.availability")}</dt>
          <dd>
            <Num>{asset?.periods.length ?? 0}</Num> חלונות
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 text-ink-500">{t("wizard.images")}</dt>
          <dd>
            <Num>{asset?.images.length ?? 0}</Num>
          </dd>
        </div>
      </dl>
      <p className="text-sm text-ink-600 bg-ink-50 border border-ink-200 rounded p-3">
        לאחר הפרסום השטח יוצג במפה ויסומן כ״{t("verify.PENDING")}״ עד לאימות VELTO.
      </p>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? t("common.loading") : t("wizard.publish")}
      </Button>
    </form>
  );
}
