import type { ReactNode } from "react";
import { InboxIcon } from "./icons";

export interface EmptyStateProps {
  title: string;
  /** Explains what to do next (§24.3). */
  description: string;
  /** Optional primary action, e.g. a button. */
  action?: ReactNode;
}

/** Placeholder for lists/tables with no content. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <InboxIcon width={32} height={32} className="text-ink-muted" />
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="max-w-md text-sm text-ink-muted">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
