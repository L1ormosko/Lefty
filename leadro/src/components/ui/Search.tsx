"use client";

import { useId } from "react";
import { controlClasses, buttonClasses, cx } from "./cx";
import { SearchIcon } from "./icons";

export interface SearchProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Emitted on Enter / button press. */
  onSearch: (value: string) => void;
  /** Accessible name of the field (visually hidden label). */
  label: string;
  placeholder?: string;
  submitLabel: string;
}

/** Search box exposed as a `search` landmark. Controlled; querying is the caller's job. */
export function Search({ value, onValueChange, onSearch, label, placeholder, submitLabel }: SearchProps) {
  const inputId = useId();
  return (
    <form
      role="search"
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(value);
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.target.value)}
        className={cx(controlClasses, "min-w-0 flex-1")}
      />
      <button type="submit" className={buttonClasses.secondary} aria-label={submitLabel}>
        <SearchIcon />
      </button>
    </form>
  );
}
