/** Small shared primitives. Restrained on purpose: one button, one card, one badge. */
import Link from "next/link";
import type { ReactNode } from "react";
import { t } from "@/lib/labels";
import { CURRENCY } from "@/lib/constants";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/*
 * `active:translate-y-px` is the whole press animation. It is one pixel and it
 * is the difference between a button that feels like a control and one that
 * feels like a coloured rectangle - and unlike a scale or a shadow change it
 * cannot reflow anything around it.
 */
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors " +
  "active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0";
const BUTTON_VARIANTS = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800",
  secondary: "bg-white text-ink-800 border border-ink-200 hover:bg-ink-50 hover:border-ink-300 active:bg-ink-100",
  ghost: "text-ink-700 hover:bg-ink-100 active:bg-ink-200",
  danger: "bg-bad-500 text-white hover:bg-bad-700 active:bg-bad-800",
  // For dark bands (the landing page's closing CTA). Declared as variants
  // rather than className overrides: Tailwind resolves conflicting utilities
  // by stylesheet order, not by prop order, so overriding a variant's colours
  // from className silently produces white-on-white.
  inverse: "bg-white text-ink-900 hover:bg-ink-100",
  inverseGhost: "border border-white/30 text-white hover:bg-white/10",
} as const;
const BUTTON_SIZES = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
} as const;

type ButtonProps = {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = "primary", size = "md", className, ...rest }: ButtonProps) {
  return <button className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)} {...rest} />;
}

/**
 * Button styling for the rare element that must be a plain <a> rather than a
 * Link - a file download, where the browser's own navigation is what turns the
 * response into a saved file and a client-side route transition would not.
 */
export function buttonClass(
  variant: keyof typeof BUTTON_VARIANTS = "primary",
  size: keyof typeof BUTTON_SIZES = "md",
  className?: string
) {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: {
  href: string;
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  className?: string;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof Link>, "href" | "className">) {
  return (
    <Link
      href={href}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...rest}
    >
      {children}
    </Link>
  );
}

/**
 * A panel of content.
 *
 * Flat by default, and that is the whole point. Every card used to carry
 * `shadow-card`, which meant a listing page was eight shadowed rectangles
 * stacked on one another and a results list was sixteen. When everything is
 * raised, nothing is: the eye gets no ranking and the screen reads as busy
 * however little is actually on it.
 *
 * So elevation is now a claim about depth rather than decoration, and it is
 * spent only on things that genuinely float above other content - the request
 * panel pinned beside the listing, the controls lying on top of the map, the
 * bottom sheet. Everything else is a bordered surface on the page.
 */
export function Card({
  className,
  interactive,
  elevated,
  children,
}: {
  className?: string;
  /** Adds hover lift. Only for a card that is itself a link or a target. */
  interactive?: boolean;
  /** Genuinely floats above other content. Rare - see the note above. */
  elevated?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "bg-white rounded-lg border border-ink-200",
        elevated && "shadow-card",
        interactive && "transition-shadow transition-colors hover:shadow-raised hover:border-ink-300",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A section of a long page: a heading and its content, with a hairline rule
 * above it instead of a box around it.
 *
 * This is what replaced the stack of cards on the listing page. Separation by
 * a rule reads as "the next thing" without adding a border, a radius and a
 * shadow to say it - which is how a page of eight sections ends up looking
 * like a page of eight competing objects.
 *
 * Not to be confused with `Section` in DashboardShell, which is the heading
 * for a block inside a dashboard and deliberately carries no rule - the rows
 * underneath it bring their own frame.
 */
export function PageSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("border-t border-ink-200 pt-6", className)}>
      <h2 className="font-semibold text-ink-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A section whose content is collapsed until asked for.
 *
 * The full specification table, the commercial breakdown and the owner's
 * contact details are all things an advertiser wants *eventually* - they are
 * not what they are looking at the page to decide. Native <details> so it
 * works without JavaScript, is keyboard-operable for free, and is found by the
 * browser's own in-page search when closed in every current engine.
 *
 * `open` for the cases where the content is short enough that hiding it buys
 * nothing.
 */
export function Collapsible({
  title,
  summary,
  open,
  children,
}: {
  title: string;
  /** A one-line preview of what is inside, shown on the closed row. */
  summary?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group border-t border-ink-200">
      <summary className="flex items-center gap-3 py-4 cursor-pointer list-none min-h-11 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold text-ink-900">{title}</span>
        {summary && <span className="text-sm text-ink-500 truncate min-w-0">{summary}</span>}
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ms-auto size-4 shrink-0 text-ink-400 transition-transform group-open:rotate-180"
          aria-hidden="true"
        >
          <path d="m5 7.5 5 5 5-5" />
        </svg>
      </summary>
      <div className="pb-6">{children}</div>
    </details>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-800">
        {label}
        {required && <span className="text-bad-500"> *</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-ink-500">{hint}</p>}
      {error && (
        <p className="text-xs text-bad-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  "w-full h-10 rounded-md border border-ink-300 bg-white px-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500";
export const textareaClass =
  "w-full rounded-md border border-ink-300 bg-white p-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500";

/** Numbers, prices and dates stay LTR inside Hebrew sentences. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <bdi className={cx("num", className)}>{children}</bdi>;
}

/**
 * A shekel amount.
 *
 * Prices were formatted at eight call sites with the same template literal
 * copied around, and rendered three visibly different ways across the explore
 * cards, the asset page and the dashboard tiles. One component, so the
 * thousands separator, the currency position and the LTR isolation are decided
 * once. `null` is the honest "not published" case rather than a zero.
 */
export function Price({
  amount,
  per,
  from,
  fallback,
  className,
}: {
  amount: number | null | undefined;
  /** "חודש" / "שבוע" - omitted for a plain total. */
  per?: string;
  from?: boolean;
  fallback?: ReactNode;
  className?: string;
}) {
  if (amount == null) {
    return <span className={cx("text-ink-400", className)}>{fallback ?? t("common.notProvided")}</span>;
  }
  return (
    <span className={className}>
      {from && t("asset.priceFrom")}
      <Num>{`${CURRENCY}${amount.toLocaleString("he-IL")}`}</Num>
      {per && ` / ${per}`}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-12 px-6">
      <p className="text-ink-800 font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-500 max-w-sm mx-auto">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "success" | "info"; children: ReactNode }) {
  const styles = {
    error: "bg-bad-50 text-bad-700 border-bad-200",
    success: "bg-ok-50 text-ok-700 border-ok-200",
    info: "bg-brand-50 text-brand-700 border-brand-200",
  } as const;
  return (
    <div role={kind === "error" ? "alert" : "status"} className={cx("rounded-md border px-3 py-2 text-sm", styles[kind])}>
      {children}
    </div>
  );
}

export function StatTile({ label, value, href }: { label: string; value: number | string; href?: string }) {
  const body = (
    <>
      <div className="text-2xl font-semibold text-ink-900">
        <Num>{value}</Num>
      </div>
      <div className="text-sm text-ink-600 mt-0.5">{label}</div>
    </>
  );
  return href ? (
    <Link
      href={href}
      className="block bg-white rounded-lg border border-ink-200 p-4 transition-shadow transition-colors hover:border-brand-300 hover:shadow-raised"
    >
      {body}
    </Link>
  ) : (
    <div className="bg-white rounded-lg border border-ink-200 p-4">{body}</div>
  );
}

/**
 * Placeholder for an asset with no photograph. We never substitute a stock
 * image: the advertiser must be able to tell the difference between a space
 * they have seen and one they have not.
 */
export function ImagePlaceholder({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-1 bg-ink-100 text-ink-400 select-none",
        className
      )}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="14" rx="2" />
        <path d="m6 15 3.5-4 2.5 3 2-2.5L18 15" />
        <circle cx="9" cy="9" r="1.2" />
        <path d="M12 18v3M8 21h8" />
      </svg>
      <span className="text-[11px]">{label}</span>
    </div>
  );
}
