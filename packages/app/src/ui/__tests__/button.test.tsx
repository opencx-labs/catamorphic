import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../button.js";

describe("Button loading (PendingButton rule)", () => {
  it("renders idle and pending labels stacked so width never changes", () => {
    const idle = render(<Button variant="primary">Save changes</Button>);
    const stackIdle = idle.container.querySelector(".cat-btn-stack");
    // Both labels are ALWAYS in the DOM — the widest one reserves the width.
    expect(stackIdle?.children).toHaveLength(2);
    expect(stackIdle?.children[0]).not.toHaveAttribute("data-hidden");
    expect(stackIdle?.children[1]).toHaveAttribute("data-hidden", "true");
    expect(stackIdle).toMatchSnapshot("idle");

    const loading = render(
      <Button variant="primary" loading loadingLabel="Saving…">
        Save changes
      </Button>,
    );
    const button = loading.container.querySelector("button");
    const stack = loading.container.querySelector(".cat-btn-stack");
    // Pending merely toggles visibility: same two children, idle now hidden.
    expect(stack?.children).toHaveLength(2);
    expect(stack?.children[0]).toHaveAttribute("data-hidden", "true");
    expect(stack?.children[0]?.textContent).toBe("Save changes");
    expect(stack?.children[1]).not.toHaveAttribute("data-hidden");
    expect(stack?.children[1]?.textContent).toContain("Saving…");
    expect(stack?.children[1]?.querySelector(".cat-spinner")).toBeTruthy();
    // Pending buttons are disabled and announced busy.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(stack).toMatchSnapshot("loading");
  });

  it("defaults the pending label to the idle label", () => {
    const { container } = render(<Button loading>Delete</Button>);
    const stack = container.querySelector(".cat-btn-stack");
    expect(stack?.children[1]?.textContent).toBe("Delete");
  });
});
