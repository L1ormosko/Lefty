// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { Drawer } from "./Drawer";

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(<Dialog open={false} onClose={() => {}} title="T" closeLabel="Close" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is labelled by its title and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Edit lead" closeLabel="Close" />);
    expect(screen.getByRole("dialog", { name: "Edit lead" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus inside the dialog", async () => {
    render(
      <>
        <button>Outside</button>
        <Dialog open onClose={() => {}} title="T" closeLabel="Close" footer={<button>Save</button>} />
      </>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(save).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it("restores focus to the opener when it closes", async () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Dialog open={open} onClose={() => setOpen(false)} title="T" closeLabel="Close" />
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open" });
    await userEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("ConfirmDialog", () => {
  function setup() {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        destructive
        title="Delete lead?"
        description="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { onConfirm, onCancel };
  }

  it("is an alertdialog and starts focused on Cancel, not the destructive action", () => {
    setup();
    expect(screen.getByRole("alertdialog", { name: "Delete lead?" })).toHaveAccessibleDescription(
      "This cannot be undone.",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("calls onConfirm only from the confirm button", async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel from the Cancel button and from Escape", async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Drawer", () => {
  it("renders a labelled dialog and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Drawer open onClose={onClose} title="Details" closeLabel="Close" />);
    expect(screen.getByRole("dialog", { name: "Details" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
