"use client";

import { useId, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select, type SelectOption } from "@/components/ui";
import { changeLocaleAction } from "../_actions/locale";

export interface LanguageSwitcherProps {
  /** Translated "Language" label (visually hidden but read by assistive tech). */
  label: string;
  currentLocale: string;
  /** One option per supported locale, labelled with its translated name. */
  options: SelectOption[];
}

/**
 * Language picker for the auth pages and the top bar. Picking a language calls the server action
 * (which remembers it, and saves it on the user when signed in) and re-renders the page in place.
 */
export function LanguageSwitcher({ label, currentLocale, options }: LanguageSwitcherProps) {
  const id = useId();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Select
        id={id}
        value={currentLocale}
        options={options}
        disabled={isPending}
        className="w-auto py-1"
        onChange={(event) => {
          const locale = event.target.value;
          startTransition(async () => {
            if (await changeLocaleAction(locale)) router.refresh();
          });
        }}
      />
    </div>
  );
}
