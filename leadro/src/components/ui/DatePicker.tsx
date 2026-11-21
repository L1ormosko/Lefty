import { forwardRef, type InputHTMLAttributes } from "react";
import { controlClasses, cx } from "./cx";

export type DatePickerProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * Thin wrapper over the native date input: keyboard accessible, localised and RTL-aware by the
 * browser, and its value is always `YYYY-MM-DD`. Use inside `Field`.
 */
export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} type="date" className={cx(controlClasses, className)} {...rest} />;
});
