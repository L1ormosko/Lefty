// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge, type StatusTone } from "./StatusBadge";

const tones: StatusTone[] = ["success", "warning", "danger", "info", "neutral"];

describe("StatusBadge", () => {
  it.each(tones)("renders the text label for tone %s (never colour only)", (tone) => {
    render(<StatusBadge tone={tone} label={`Status ${tone}`} />);
    expect(screen.getByText(`Status ${tone}`)).toBeVisible();
  });

  it.each(tones)("adds a decorative icon for tone %s", (tone) => {
    const { container } = render(<StatusBadge tone={tone} label="x" />);
    const icon = container.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
