/** Small shared primitives. Restrained on purpose: one button, one card, one badge. */
import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const BUTTON_VARIANTS = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary: "bg-white text-ink-800 border border-ink-200 hover:bg-ink-50",
  ghost: "text-ink-700 hover:bg-ink-100",
  danger: "bg-bad-500 text-white hover:bg-bad-700",
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

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("bg-white rounded-lg border border-ink-200 shadow-card", className)}>{children}</div>
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
    error: "bg-bad-50 text-bad-700 border-bad-500/30",
    success: "bg-ok-50 text-ok-700 border-ok-500/30",
    info: "bg-brand-50 text-brand-700 border-brand-500/30",
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
    <Link href={href} className="block bg-white rounded-lg border border-ink-200 p-4 shadow-card hover:border-brand-300">
      {body}
    </Link>
  ) : (
    <div className="bg-white rounded-lg border border-ink-200 p-4 shadow-card">{body}</div>
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
