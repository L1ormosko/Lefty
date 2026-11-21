// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Field } from "./Field";
import { Search } from "./Search";
import { TextInput } from "./TextInput";

describe("Field", () => {
  it("links label, hint and error to the control", () => {
    render(
      <Field label="Email" hint="Work address" error="Enter a valid email" required>
        {(props) => <TextInput {...props} />}
      </Field>,
    );
    const input = screen.getByLabelText(/Email/);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Work address Enter a valid email");
  });

  it("omits aria-invalid when there is no error", () => {
    render(<Field label="Name">{(props) => <TextInput {...props} />}</Field>);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
  });
});

describe("Search", () => {
  it("emits the typed value on submit", async () => {
    const onSearch = vi.fn();
    render(
      <Search value="abc" onValueChange={() => {}} onSearch={onSearch} label="Search" submitLabel="Go" />,
    );
    expect(screen.getByRole("search")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onSearch).toHaveBeenCalledWith("abc");
  });
});
