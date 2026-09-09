/** Shared row renderers for the dashboards. */
import Link from "next/link";
import { t } from "@/lib/labels";
import { formatRange, formatDate } from "@/lib/dates";
import { effectiveBookingStatus } from "@/lib/bookings";
import { Card, Num, Price } from "./ui";
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
    createdAt: Date;
    /** Latest message first; the list only ever needs the most recent one. */
    messages?: { body: string; createdAt: Date }[];
    _count?: { messages: number };
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string | null;
    asset: {
      id: string;
      title: string;
      city?: string;
      company?: { name: string; contactEmail: string; contactPhone: string | null } | null;
    };
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
            <Price amount={inquiry.budget} />
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

      {inquiry.messages?.[0] && (
        <div className="mt-3 border-s-2 border-brand-500 ps-3">
          <p className="text-xs text-ink-500">
            {t("inquiry.lastMessage")}
            {inquiry._count && inquiry._count.messages > 1 && (
              <>
                {" · "}
                <Num>{inquiry._count.messages}</Num> {t("inquiry.messages")}
              </>
            )}
          </p>
          <p className="text-sm text-ink-800 whitespace-pre-line line-clamp-3">
            {inquiry.messages[0].body}
          </p>
        </div>
      )}

      {perspective === "advertiser" && inquiry.status === "RESPONDED" && inquiry.asset.company && (
        <div className="mt-3 border-s-2 border-ok-500 ps-3">
          <p className="text-xs text-ink-500">{t("booking.contactOwner")}</p>
          <p className="text-sm text-ink-800">{inquiry.asset.company.name}</p>
          <a
            href={`mailto:${inquiry.asset.company.contactEmail}`}
            dir="ltr"
            className="block text-sm text-brand-600 hover:underline w-fit"
          >
            {inquiry.asset.company.contactEmail}
          </a>
          {inquiry.asset.company.contactPhone && (
            <a href={`tel:${inquiry.asset.company.contactPhone}`} className="block text-sm text-brand-600 hover:underline w-fit">
              <Num>{inquiry.asset.company.contactPhone}</Num>
            </a>
          )}
        </div>
      )}

      {children && <div className="mt-3 pt-3 border-t border-ink-100">{children}</div>}
    </Card>
  );
}

export function BookingRow({
  booking,
  perspective = "advertiser",
  children,
}: {
  booking: {
    id: string;
    startDate: Date;
    endDate: Date;
    priceEstimate: number | null;
    status: string;
    ownerNote: string | null;
    asset: {
      id: string;
      title: string;
      company?: { name: string; contactEmail: string; contactPhone: string | null } | null;
    };
    advertiser?: { name: string; email: string; phone?: string | null };
    inquiryId?: string | null;
  };
  /** Where this row lives, so the provenance link points at the right side. */
  perspective?: "advertiser" | "owner";
  children?: React.ReactNode;
}) {
  // COMPLETED is derived from the end date, never stored - see lib/bookings.ts.
  const status = effectiveBookingStatus(booking);
  const showOwnerContact = booking.status === "APPROVED" && booking.asset.company;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-2">
        <Link href={`/assets/${booking.asset.id}`} className="font-medium text-ink-900 hover:underline flex-1 min-w-0">
          {booking.asset.title}
        </Link>
        <StatusPill label={t(`booking.${status}`)} tone={bookingTone(status)} />
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
            <Price amount={booking.priceEstimate} />
          </dd>
        </div>
        {booking.advertiser && (
          <div>
            <dt className="text-ink-500 text-xs">{t("role.ADVERTISER")}</dt>
            <dd className="text-ink-900">
              {booking.advertiser.name}
              {booking.advertiser.phone && (
                <>
                  {" · "}
                  <Num>{booking.advertiser.phone}</Num>
                </>
              )}
            </dd>
          </div>
        )}
      </dl>
      {booking.ownerNote && <p className="mt-2 text-sm text-ink-700">{booking.ownerNote}</p>}

      {/* Which conversation this booking came out of. Booking.inquiryId was
          already stored and never shown, so comparing several concurrent
          requests meant guessing which one turned into which booking. */}
      {booking.inquiryId && (
        <p className="mt-2 text-sm">
          <Link
            href={
              perspective === "owner"
                ? `/owner/inquiries/${booking.inquiryId}`
                : `/dashboard/requests/${booking.inquiryId}`
            }
            className="text-brand-600 hover:underline"
          >
            {t("booking.fromInquiry")}
          </Link>
        </p>
      )}

      {booking.advertiser?.email && (
        <p className="mt-1 text-sm">
          <a href={`mailto:${booking.advertiser.email}`} dir="ltr" className="text-brand-600 hover:underline">
            {booking.advertiser.email}
          </a>
        </p>
      )}

      {showOwnerContact && booking.asset.company && (
        <div className="mt-3 border-s-2 border-ok-500 ps-3">
          <p className="text-xs text-ink-500">{t("booking.contactOwner")}</p>
          <p className="text-sm text-ink-800">{booking.asset.company.name}</p>
          <a
            href={`mailto:${booking.asset.company.contactEmail}`}
            dir="ltr"
            className="block text-sm text-brand-600 hover:underline w-fit"
          >
            {booking.asset.company.contactEmail}
          </a>
          {booking.asset.company.contactPhone && (
            <a href={`tel:${booking.asset.company.contactPhone}`} className="block text-sm text-brand-600 hover:underline w-fit">
              <Num>{booking.asset.company.contactPhone}</Num>
            </a>
          )}
        </div>
      )}

      {children && <div className="mt-3 pt-3 border-t border-ink-100">{children}</div>}
    </Card>
  );
}
