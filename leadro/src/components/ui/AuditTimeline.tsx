export interface AuditTimelineEntry {
  id: string;
  /** Already-translated summary, e.g. "Status changed to Approved". */
  title: string;
  /** Display name of the actor. */
  actor: string;
  /** Locale-formatted timestamp text (formatting is the caller's job: i18n). */
  timestampLabel: string;
  /** Machine-readable ISO timestamp for the <time> element. */
  timestampIso: string;
  description?: string;
}

export interface AuditTimelineProps {
  /** Accessible name of the list. */
  label: string;
  entries: AuditTimelineEntry[];
}

/** Read-only chronological list of audit events (spec §21). Order is the caller's. */
export function AuditTimeline({ label, entries }: AuditTimelineProps) {
  return (
    <ol aria-label={label} className="border-s-2 border-line ps-4">
      {entries.map((entry) => (
        <li key={entry.id} className="relative pb-5 last:pb-0">
          <span
            aria-hidden="true"
            className="absolute -start-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-brand-600"
          />
          <p className="text-sm font-medium text-ink">{entry.title}</p>
          <p className="text-xs text-ink-muted">
            {entry.actor} · <time dateTime={entry.timestampIso}>{entry.timestampLabel}</time>
          </p>
          {entry.description ? (
            <p className="mt-1 text-sm text-ink-muted">{entry.description}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
