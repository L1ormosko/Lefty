"use client";

import { useId, type ReactNode } from "react";
import { XCircleIcon } from "./icons";

/** Props a Field hands to its control so label, hint and error are programmatically linked. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: boolean;
}

export interface LabelProps {
  htmlFor: string;
  children: ReactNode;
  /** Shows a decorative asterisk; the control itself carries the `required` attribute. */
  required?: boolean;
}

/** Visible label for a form control. */
export function Label({ htmlFor, children, required }: LabelProps) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
      {children}
      {required ? (
        <span aria-hidden="true" className="ms-1 text-danger">
          *
        </span>
      ) : null}
    </label>
  );
}

export interface FieldErrorProps {
  id?: string;
  /** Translated message that names the problem and how to fix it (§24.3). */
  children: ReactNode;
}

/** Inline validation message. Icon + text, so it is not colour-only. */
export function FieldError({ id, children }: FieldErrorProps) {
  return (
    <p id={id} className="mt-1 flex items-start gap-1 text-sm text-danger">
      <XCircleIcon className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Render-prop so the control receives the generated id and aria wiring. */
  children: (controlProps: FieldControlProps) => ReactNode;
}

/** Label + control + hint + error as one accessible unit. */
export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className="space-y-1">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
        required,
      })}
      {hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
