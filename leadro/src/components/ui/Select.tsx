import { forwardRef, type SelectHTMLAttributes } from "react";
import { controlClasses, cx } from "./cx";

export interface SelectOption {
  value: string;
  /** Already-translated option text. */
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  /** Translated text of an empty first option, e.g. "Choose…". Omit for no placeholder. */
  placeholder?: string;
}

/** Styled native select. Use inside `Field`. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, className, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(controlClasses, className)} {...rest}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
});
