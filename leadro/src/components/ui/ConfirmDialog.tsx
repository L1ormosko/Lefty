"use client";

import { useId } from "react";
import { Overlay } from "./Overlay";
import { buttonClasses } from "./cx";

export interface ConfirmDialogProps {
  open: boolean;
  /** See `OverlayProps.dir`; normally omitted. */
  dir?: "ltr" | "rtl";
  title: string;
  /** Says what will happen and that it may be irreversible (§24.3: destructive actions need confirmation). */
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  onConfirm: () => void;
  /** Called by the Cancel button, Escape, and backdrop click. */
  onCancel: () => void;
}

/**
 * Confirmation variant of Dialog (role=alertdialog). Initial focus lands on the first button,
 * which is Cancel, so an accidental Enter never confirms a destructive action.
 */
export function ConfirmDialog({
  open,
  dir,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Overlay
      open={open}
      dir={dir}
      onClose={onCancel}
      role="alertdialog"
      labelledBy={titleId}
      describedBy={descriptionId}
      backdropClassName="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
      panelClassName="w-full max-w-md rounded-lg bg-surface p-6 shadow-overlay focus:outline-none"
    >
      <h2 id={titleId} className="text-lg font-semibold text-ink">
        {title}
      </h2>
      <p id={descriptionId} className="mt-2 text-sm text-ink-muted">
        {description}
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={buttonClasses.secondary}>
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={destructive ? buttonClasses.danger : buttonClasses.primary}
        >
          {confirmLabel}
        </button>
      </div>
    </Overlay>
  );
}
