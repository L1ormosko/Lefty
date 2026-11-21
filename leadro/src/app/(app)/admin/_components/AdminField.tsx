import type { ReactNode } from "react";
import { Label } from "@/components/ui";

export interface AdminFieldProps {
  label: string;
  /** The `id` the control inside `children` must carry (links label and control). */
  htmlFor: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}

/**
 * Label + control for forms rendered by server components. The shared `Field` takes a render
 * function and so can only live inside client components; server-rendered forms pass the control
 * as plain children and name its id explicitly.
 */
export function AdminField({ label, htmlFor, hint, required, children }: AdminFieldProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}
