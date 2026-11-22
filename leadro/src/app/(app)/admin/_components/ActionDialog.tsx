"use client";

import { useActionState, useEffect, useId, useState, type ReactNode } from "react";
import { Dialog, buttonClasses } from "@/components/ui";
import { FormAlert } from "../../../_components/FormAlert";
import { INITIAL_FORM_STATE, type FormState } from "../../../_lib/form-state";

export type FormAction = (previous: FormState, formData: FormData) => Promise<FormState>;

export interface ActionDialogProps {
  /** Already-translated text of the button that opens the dialog. */
  triggerLabel: string;
  triggerVariant?: "primary" | "secondary" | "danger";
  title: string;
  description?: string;
  submitLabel: string;
  cancelLabel: string;
  closeLabel: string;
  /** A server action; it re-checks permission itself (this component only shows the result). */
  action: FormAction;
  /** Styles the submit button as destructive. */
  destructive?: boolean;
  /** The form fields, rendered by the server (they are plain elements, so no client code is needed). */
  children: ReactNode;
}

interface FormBodyProps extends Omit<ActionDialogProps, "triggerLabel" | "triggerVariant"> {
  onSuccess: (message: string) => void;
  onClose: () => void;
}

/** Mounted only while the dialog is open, so every opening starts with an empty form and no stale error. */
function DialogForm({ title, description, submitLabel, cancelLabel, closeLabel, action, destructive, children, onSuccess, onClose }: FormBodyProps) {
  const formId = useId();
  const [state, formAction, isPending] = useActionState(action, INITIAL_FORM_STATE);

  useEffect(() => {
    if (state.success) onSuccess(state.success);
  }, [state.success, onSuccess]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      closeLabel={closeLabel}
      footer={
        <>
          <button type="button" className={buttonClasses.secondary} onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="submit" form={formId} className={destructive ? buttonClasses.danger : buttonClasses.primary} disabled={isPending}>
            {submitLabel}
          </button>
        </>
      }
    >
      <form id={formId} action={formAction} className="space-y-4">
        {state.error ? <FormAlert tone="danger">{state.error}</FormAlert> : null}
        {children}
      </form>
    </Dialog>
  );
}

/**
 * A button that opens a dialog with a form bound to a server action. On success the dialog closes
 * and the confirmation stays visible next to the button (a polite live region), because the page
 * behind it is re-rendered by the action's revalidation.
 */
export function ActionDialog({ triggerLabel, triggerVariant = "secondary", ...dialog }: ActionDialogProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className={buttonClasses[triggerVariant]}
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}
      >
        {triggerLabel}
      </button>
      <span role="status" className="text-sm text-success">
        {message}
      </span>
      {open ? (
        <DialogForm
          {...dialog}
          onClose={() => setOpen(false)}
          onSuccess={(text) => {
            setMessage(text);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
