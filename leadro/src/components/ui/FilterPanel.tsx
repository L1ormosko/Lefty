"use client";

import { useId, type ReactNode } from "react";
import { buttonClasses } from "./cx";

export interface FilterPanelProps {
  title: string;
  applyLabel: string;
  resetLabel: string;
  onApply: () => void;
  onReset: () => void;
  /** Filter fields (compose with Field/Select/TextInput/DatePicker). */
  children: ReactNode;
}

/** Group of filter controls with Apply/Reset; the caller owns the filter state. */
export function FilterPanel({ title, applyLabel, resetLabel, onApply, onReset, children }: FilterPanelProps) {
  const titleId = useId();
  return (
    <form
      aria-labelledby={titleId}
      className="space-y-3 rounded border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
      onReset={(event) => {
        event.preventDefault();
        onReset();
      }}
    >
      <h2 id={titleId} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
      <div className="flex gap-2">
        <button type="submit" className={buttonClasses.primary}>
          {applyLabel}
        </button>
        <button type="reset" className={buttonClasses.secondary}>
          {resetLabel}
        </button>
      </div>
    </form>
  );
}
