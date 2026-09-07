/** Shared row renderers for the dashboards. */
import Link from "next/link";
import { t } from "@/lib/labels";
import { CURRENCY } from "@/lib/constants";
import { formatRange, formatDate } from "@/lib/dates";
import { Card, Num } from "./ui";
import { StatusPill, bookingTone } from "./badges";

export function InquiryRow({
  inquiry,
  perspective,
  children,
}: {
  inquiry: {
    id: string;
    campaignName: string;
    startDate: Date;
    endDate: Date;
    budget: number | null;
    message: string | null;
    status: string;
    intent: string;
    ownerResponse: string | null;
    createdAt: Date;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string | null;
    asset: { id: string; title: string; city?: string };
  };
  perspective: "advertiser" | "owner";
  children?: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link href={`/assets/${inquiry.asset.id}`} className="font-medium text-ink-900 hover:underline">
            {inquiry.asset.title}
          </Link>
          <p className="text-sm text-ink-600 mt-0.5">{inquiry.campaignName}</p>
        </div>
        <div className="flex gap-1.5">
          <StatusPill label={t(`intent.${inquiry.intent}`)} />
          <StatusPill
            label={t(`inquiry.${inquiry.status}`)}
            tone={inquiry.status === "PENDING" ? "warn" : inquiry.status === "RESPONDED" ? "ok" : "neutral"}
          />
        </div>
      </div>

      <dl className="mt-3 grid sm:grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-ink-500 text-xs">{t("request.dates")}</dt>
          <dd className="text-ink-900">
            <Num>{formatRange(inquiry.startDate, inquiry.endDate)}</Num>
          </dd>
        </div>
        <div>
          <dt className="text-ink-500 text-xs">{t("request.budget")}</dt>
          <dd className="text-ink-900">
            {inquiry.budget != null ? (
              <Num>{`${CURRENCY}${inquiry.budget.toLocaleString("he-IL")}`}</Num>
            ) : (
              <span className="text-ink-400">{t("common.notProvided")}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-ink-500 text-xs">נשלחה</dt>
          <dd className="text-ink-900">
            <Num>{formatDate(inquiry.createdAt)}</Num>
          </dd>
        </div>
      </dl>

      {inquiry.message && (
        <p className="mt-3 text-sm text-ink-700 bg-ink-50 border border-ink-200 rounded p-3 whitespace-pre-line">
          {inquiry.message}
        </p>
      )}

      {perspective === "owner" && inquiry.contactName && (
        <p className="mt-2 text-sm text-ink-600">
          {t("request.contact")}: {inquiry.contactName} ·{" "}
          <a href={`mailto:${inquiry.contactEmail}`} className="text-brand-600 hover:underline" dir="ltr">
            {inquiry.contactEmail}
          </a>
          {inquiry.contactPhone && (
            <>
              {" · "}
              <Num>{inquiry.contactPhone}</Num>
            </>
          )}
        </p>
      )}

      {inquiry.ownerResponse && (
        <div className="mt-3 border-s-2 border-brand-500 ps-3">
          <p className="text-xs text-ink-500">{t("dash.respond")}</p>
          <p className="text-sm text-ink-800 whitespace-pre-line">{inquiry.ownerResponse}</p>
        </div>
      )}

      {children && <div className="mt-3 pt-3 border-t border-ink-100">{children}</div>}
    </Card>
  );
}

export function BookingRow({
  booking,
  children,
}: {
  booking: {
    id: string;
    startDate: Date;
    endDate: Date;
    priceEstimate: number | null;
    status: string;
    ownerNote: string | null;
    asset: { id: string; title: string };
    advertiser?: { name: string; email: string };
  };
  children?: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-2">
        <Link href={`/assets/${booking.asset.id}`} className="font-medium text-ink-900 hover:underline flex-1 min-w-0">
          {booking.asset.title}
        </Link>
        <StatusPill label={t(`booking.${booking.status}`)} tone={bookingTone(booking.status)} />
      </div>
      <dl className="mt-3 grid sm:grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-ink-500 text-xs">{t("request.dates")}</dt>
          <dd>
            <Num>{formatRange(booking.startDate, booking.endDate)}</Num>
          </dd>
        </div>
        <div>
          <dt className="text-ink-500 text-xs">{t("asset.priceFrom")}</dt>
          <dd>
            {booking.priceEstimate != null ? (
              <Num>{`${CURRENCY}${booking.priceEstimate.toLocaleString("he-IL")}`}</Num>
            ) : (
              <span className="text-ink-400">{t("common.notProvided")}</span>
            )}
          </dd>
        </div>
        {booking.advertiser && (
          <div>
            <dt className="text-ink-500 text-xs">{t("role.ADVERTISER")}</dt>
            <dd className="text-ink-900">{booking.advertiser.name}</dd>
          </div>
        )}
      </dl>
      {booking.ownerNote && <p className="mt-2 text-sm text-ink-700">{booking.ownerNote}</p>}
      {children && <div className="mt-3 pt-3 border-t border-ink-100">{children}</div>}
    </Card>
  );
}
