"use client";

import { useId, type ReactNode } from "react";
import { Overlay } from "./Overlay";
import { buttonClasses, cx } from "./cx";

export interface DrawerProps {
  open: boolean;
  /** See `OverlayProps.dir`; normally omitted. */
  dir?: "ltr" | "rtl";
  onClose: () => void;
  title: string;
  closeLabel: string;
  /** Edge the drawer attaches to. Logical, so "end" is the left edge in RTL. */
  side?: "start" | "end";
  children?: ReactNode;
  footer?: ReactNode;
}

/** Side panel for detail views and long forms; same modal behaviour as Dialog. */
export function Drawer({ open, dir, onClose, title, closeLabel, side = "end", children, footer }: DrawerProps) {
  const titleId = useId();
  return (
    <Overlay
      open={open}
      dir={dir}
      onClose={onClose}
      labelledBy={titleId}
      backdropClassName="fixed inset-0 z-50 bg-ink/50"
      panelClassName={cx(
        "absolute inset-y-0 flex w-full max-w-md flex-col bg-surface shadow-overlay focus:outline-none",
        side === "end" ? "end-0" : "start-0",
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line p-4">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label={closeLabel} className={buttonClasses.secondary}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
      {footer ? <div className="flex justify-end gap-2 border-t border-line p-4">{footer}</div> : null}
    </Overlay>
  );
}
