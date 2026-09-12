/**
 * What the home page shows instead of metrics that can only say zero.
 *
 * Shopify's merchant home does not render its metrics section at all until the
 * store has made a sale; before that, Home is a setup checklist. VELTO's owner
 * home used to open with four stat tiles reading 0, 0, 0, ₪0 - which is the
 * product telling a new owner it has nothing for them, in the one place it is
 * supposed to be making its case.
 *
 * Numbered rather than checkboxed on purpose: these are steps to take, not a
 * completeness score. The product does not claim that finishing them produces
 * more views, because it has no evidence that it does.
 */
import type { ReactNode } from "react";
import { Card, Num } from "@/components/ui";

export function FirstSteps({
  title,
  lead,
  steps,
  action,
}: {
  title: string;
  lead: string;
  steps: string[];
  action: ReactNode;
}) {
  return (
    <Card className="p-6 mb-6">
      <h2 className="font-semibold text-ink-900">{title}</h2>
      <p className="mt-1 text-sm text-ink-600 max-w-xl">{lead}</p>
      <ol className="mt-5 space-y-4">
        {steps.map((step, i) => (
          <li key={step} className="flex gap-3">
            <span className="shrink-0 size-7 rounded-full bg-brand-50 text-brand-700 border border-brand-200 text-sm font-semibold flex items-center justify-center">
              <Num>{i + 1}</Num>
            </span>
            <p className="text-sm text-ink-800 pt-0.5">{step}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6">{action}</div>
    </Card>
  );
}
