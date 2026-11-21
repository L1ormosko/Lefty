"use client";

import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { focusRing } from "./cx";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  description?: string;
}

/** Checkbox with its own label (and optional description); the whole label is clickable. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, id, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = `${inputId}-description`;
  return (
    <div className="flex items-start gap-2">
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        aria-describedby={description ? descriptionId : undefined}
        className={`mt-0.5 h-4 w-4 rounded border-line-strong accent-brand-600 ${focusRing}`}
        {...rest}
      />
      <div>
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-xs text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
});
