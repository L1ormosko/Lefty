import { t } from "@/lib/labels";
import { formatDate, formatRange } from "@/lib/dates";
import { CURRENCY } from "@/lib/constants";
import { Card, Num } from "@/components/ui";
import { InquiryMessageForm } from "@/components/InquiryMessageForm";

type Message = {
  id: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; role: string };
};

type Inquiry = {
  id: string;
  campaignName: string;
  startDate: Date;
  endDate: Date;
  budget: number | null;
  message: string | null;
  status: string;
  intent: string;
  createdAt: Date;
  contactName: string;
  advertiserId: string;
  asset: { id: string; title: string; city: string };
};

/**
 * One inquiry, as a conversation.
 *
 * The brief - dates, budget, campaign name and the advertiser's opening
 * message - stays structured at the top rather than being flattened into a
 * chat bubble: it is the thing being negotiated, not a remark about it. The
 * opening message is shown as the first thing said, so the thread reads in
 * order even though it is stored on the inquiry itself.
 */
export function InquiryThread({
  inquiry,
  messages,
  viewerId,
}: {
  inquiry: Inquiry;
  messages: Message[];
  viewerId: string;
}) {
  return (
    <div className="space-y-4 max-w-3xl">
      <Card className="p-5">
        <h2 className="font-semibold text-ink-900">{inquiry.asset.title}</h2>
        <p className="text-sm text-ink-500">{inquiry.asset.city}</p>

        <dl className="mt-4 grid sm:grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-ink-500 text-xs">{t("request.campaign")}</dt>
            <dd className="text-ink-900">{inquiry.campaignName}</dd>
          </div>
          <div>
            <dt className="text-ink-500 text-xs">{t("request.dates")}</dt>
            <dd>
              <Num>{formatRange(inquiry.startDate, inquiry.endDate)}</Num>
            </dd>
          </div>
          <div>
            <dt className="text-ink-500 text-xs">{t("request.budget")}</dt>
            <dd>
              {inquiry.budget != null ? (
                <Num>{`${CURRENCY}${inquiry.budget.toLocaleString("he-IL")}`}</Num>
              ) : (
                <span className="text-ink-400">{t("common.notProvided")}</span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <ol className="space-y-3">
        {/* The opening message lives on the inquiry, not in the message table,
            but it is the first thing said - so the thread shows it that way. */}
        {inquiry.message && (
          <Bubble
            name={inquiry.contactName}
            at={inquiry.createdAt}
            body={inquiry.message}
            mine={viewerId === inquiry.advertiserId}
          />
        )}
        {messages.map((m) => (
          <Bubble
            key={m.id}
            name={m.author.name}
            at={m.createdAt}
            body={m.body}
            mine={m.author.id === viewerId}
          />
        ))}
      </ol>

      {inquiry.status === "CLOSED" ? (
        <p className="text-sm text-ink-500">{t("inquiry.closed")}</p>
      ) : (
        <Card className="p-4">
          <InquiryMessageForm inquiryId={inquiry.id} />
        </Card>
      )}
    </div>
  );
}

function Bubble({
  name,
  at,
  body,
  mine,
}: {
  name: string;
  at: Date;
  body: string;
  mine: boolean;
}) {
  return (
    <li
      className={
        mine
          ? "rounded-lg border border-brand-500/30 bg-brand-50 p-4"
          : "rounded-lg border border-ink-200 bg-white p-4"
      }
    >
      <p className="text-xs text-ink-500">
        {name}
        {" · "}
        <Num>{formatDate(at)}</Num>
      </p>
      <p className="mt-1 text-sm text-ink-900 whitespace-pre-line">{body}</p>
    </li>
  );
}
