"use client";

import { useState, useTransition } from "react";
import { ConfirmDialog, buttonClasses } from "@/components/ui";
import type { FormAction } from "./ActionDialog";

export interface ConfirmActionButtonProps {
  triggerLabel: string;
  triggerVariant?: "secondary" | "danger";
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  /** Server action; runs only after the user confirms. */
  action: FormAction;
  /** Hidden inputs of the action (ids etc.). Never secrets. */
  fields: Record<string, string>;
}

/**
 * Button + ConfirmDialog for actions that need no further input (end an assignment, unassign a
 * manager). The action is still authorised on the server; this only asks "are you sure?".
 */
export function ConfirmActionButton({
  triggerLabel,
  triggerVariant = "secondary",
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  action,
  fields,
}: ConfirmActionButtonProps) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ error?: string; success?: string }>({});
  const [isPending, startTransition] = useTransition();

  const confirm = () => {
    const formData = new FormData();
    for (const [name, value] of Object.entries(fields)) formData.set(name, value);
    startTransition(async () => {
      setResult(await action({}, formData));
      setOpen(false);
    });
  };

  return (
    <>
      <button type="button" className={buttonClasses[triggerVariant]} disabled={isPending} onClick={() => setOpen(true)}>
        {triggerLabel}
      </button>
      {result.error ? (
        <span role="alert" className="text-sm text-danger">
          {result.error}
        </span>
      ) : (
        <span role="status" className="text-sm text-success">
          {result.success}
        </span>
      )}
      <ConfirmDialog
        open={open}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        destructive={destructive}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
