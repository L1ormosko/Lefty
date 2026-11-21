import { forwardRef, type InputHTMLAttributes } from "react";
import { controlClasses, cx } from "./cx";

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

/** Styled text input. Use inside `Field` to get label/error wiring. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, type = "text", ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={cx(controlClasses, className)} {...rest} />;
});
