/** Joins class names, skipping falsy values. Tiny stand-in for the `clsx` package. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Shared visible keyboard-focus style (spec §23.4). Use on every interactive element. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2";

/** Shared look for text-like form controls. */
export const controlClasses =
  "block w-full rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink " +
  "placeholder:text-ink-muted disabled:bg-neutral-soft disabled:text-ink-muted " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:border-2 " +
  focusRing;

/** Shared look for buttons; `primary` is the single main action of a screen (spec §24.3). */
export const buttonClasses = {
  primary: `inline-flex items-center justify-center rounded bg-brand-600 px-4 py-2 text-sm font-medium text-ink-inverse hover:bg-brand-700 disabled:opacity-60 ${focusRing}`,
  secondary: `inline-flex items-center justify-center rounded border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-neutral-soft disabled:opacity-60 ${focusRing}`,
  danger: `inline-flex items-center justify-center rounded bg-danger px-4 py-2 text-sm font-medium text-ink-inverse hover:opacity-90 disabled:opacity-60 ${focusRing}`,
} as const;
