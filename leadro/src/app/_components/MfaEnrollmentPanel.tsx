"use client";

import { useActionState } from "react";
import { buttonClasses } from "@/components/ui";
import {
  confirmMfaEnrollmentAction,
  startMfaEnrollmentAction,
  type EnrollmentStartState,
} from "../_actions/mfa";
import { FormAlert } from "./FormAlert";
import { MfaCodeForm } from "./MfaCodeForm";

export interface MfaEnrollmentLabels {
  start: string;
  instructions: string;
  manualKeyLabel: string;
  uriLabel: string;
  uriHelp: string;
  codeLabel: string;
  codeHint: string;
  confirm: string;
}

/**
 * Authenticator enrollment. Step 1 asks the server for a seed and shows it as text (manual key
 * and otpauth URI; a QR code is optional and would need a dependency, so it is not rendered).
 * Step 2 confirms with the first code. The seed lives only in this component's state: the server
 * never returns it again, so a reload starts over with a new seed.
 */
export function MfaEnrollmentPanel({ labels }: { labels: MfaEnrollmentLabels }) {
  const [start, startAction, isStarting] = useActionState<EnrollmentStartState>(startMfaEnrollmentAction, {});

  if (!start.secret) {
    return (
      <form action={startAction} className="space-y-3">
        {start.error ? <FormAlert tone="danger">{start.error}</FormAlert> : null}
        <p className="text-sm text-ink-muted">{labels.instructions}</p>
        <button type="submit" disabled={isStarting} className={buttonClasses.primary}>
          {labels.start}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">{labels.uriHelp}</p>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="font-medium">{labels.manualKeyLabel}</dt>
          <dd dir="ltr" className="mt-1 select-all break-all rounded border border-line bg-neutral-soft px-3 py-2 font-mono text-start">
            {start.secret}
          </dd>
        </div>
        <div>
          <dt className="font-medium">{labels.uriLabel}</dt>
          <dd dir="ltr" className="mt-1 select-all break-all rounded border border-line bg-neutral-soft px-3 py-2 font-mono text-xs text-start">
            {start.otpauthUri}
          </dd>
        </div>
      </dl>
      <MfaCodeForm
        action={confirmMfaEnrollmentAction}
        codeLabel={labels.codeLabel}
        codeHint={labels.codeHint}
        submitLabel={labels.confirm}
      />
    </div>
  );
}
