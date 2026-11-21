"use client";

import { useId, type ReactNode } from "react";
import { Overlay } from "./Overlay";
import { buttonClasses } from "./cx";

export interface DialogProps {
  open: boolean;
  /** See `OverlayProps.dir`; normally omitted. */
  dir?: "ltr" | "rtl";
  onClose: () => void;
  title: string;
  description?: string;
  /** Accessible name of the close button (translated). */
  closeLabel: string;
  children?: ReactNode;
  /** Action buttons, rendered at the end of the dialog. */
  footer?: ReactNode;
}

/** Modal dialog with focus trap, Escape to close, and focus restoration. */
export function Dialog({ open, dir, onClose, title, description, closeLabel, children, footer }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Overlay
      open={open}
      dir={dir}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      backdropClassName="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
      panelClassName="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-surface p-6 shadow-overlay focus:outline-none"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label={closeLabel} className={buttonClasses.secondary}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {description ? (
        <p id={descriptionId} className="mt-2 text-sm text-ink-muted">
          {description}
        </p>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
      {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
    </Overlay>
  );
}
