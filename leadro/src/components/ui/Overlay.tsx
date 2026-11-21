"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface OverlayProps {
  open: boolean;
  /** Called on Escape or backdrop click. */
  onClose: () => void;
  /** id of the element that names the dialog (aria-labelledby). */
  labelledBy: string;
  describedBy?: string;
  /** Role of the panel; `alertdialog` is used for destructive confirmations. */
  role?: "dialog" | "alertdialog";
  /**
   * Overrides text direction. Normally omitted: the portal inherits `<html dir>`. Only needed
   * when a subtree has its own `dir` (the dev gallery's RTL preview).
   */
  dir?: "ltr" | "rtl";
  /** Positions the panel inside the backdrop (e.g. centred, or pinned to one edge). */
  backdropClassName: string;
  panelClassName: string;
  children: ReactNode;
}

/**
 * Shared modal behaviour for Dialog and Drawer (spec §23.4): renders in a portal, moves focus
 * into the panel, traps Tab, closes on Escape, and restores focus to the opener on close.
 */
export function Overlay({
  open,
  onClose,
  labelledBy,
  describedBy,
  role = "dialog",
  dir,
  backdropClassName,
  panelClassName,
  children,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without re-running the focus effect on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const found = panelRef.current;
    if (!found) return;
    const panel: HTMLDivElement = found; // non-null alias so the closures below type-check

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (focusables()[0] ?? panel).focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      dir={dir}
      className={backdropClassName}
      onMouseDown={(event) => {
        // Only a press on the backdrop itself closes; presses inside the panel bubble here too.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={panelClassName}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
