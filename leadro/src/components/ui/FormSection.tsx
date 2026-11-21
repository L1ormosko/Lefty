import type { ReactNode } from "react";

export interface FormSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/** Groups related fields under a legend so long forms stay scannable (§24.3). */
export function FormSection({ title, description, children }: FormSectionProps) {
  return (
    <fieldset className="space-y-4 rounded border border-line bg-surface p-4">
      <legend className="px-1 text-base font-semibold text-ink">{title}</legend>
      {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
      {children}
    </fieldset>
  );
}
