"use client";

import { buttonClasses } from "./cx";
import { ChevronIcon } from "./icons";

export interface PaginationLabels {
  /** Accessible name of the <nav>. */
  navigation: string;
  previous: string;
  next: string;
  /** Translated summary such as "Page 2 of 5" — the caller formats it. */
  status: string;
}

export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  labels: PaginationLabels;
}

/** Previous/next pager. Page changes are emitted; fetching is the caller's job. */
export function Pagination({ page, pageCount, onPageChange, labels }: PaginationProps) {
  return (
    <nav aria-label={labels.navigation} className="flex items-center justify-between gap-3 text-sm">
      <button
        type="button"
        className={buttonClasses.secondary}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronIcon back className="me-1" />
        {labels.previous}
      </button>
      <span aria-live="polite" className="text-ink-muted">
        {labels.status}
      </span>
      <button
        type="button"
        className={buttonClasses.secondary}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        {labels.next}
        <ChevronIcon className="ms-1" />
      </button>
    </nav>
  );
}
