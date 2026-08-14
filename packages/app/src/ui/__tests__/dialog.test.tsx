import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../button.js";
import { Dialog } from "../dialog.js";
import { Input } from "../input.js";

function Host({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Confirm"
        footer={
          <>
            <Button>Cancel</Button>
            <Button variant="primary">Ship it</Button>
          </>
        }
      >
        <Input aria-label="Name" />
      </Dialog>
    </div>
  );
}

describe("Dialog", () => {
  it("moves focus in on open, traps Tab, and restores focus on close", () => {
    render(<Host />);
    const opener = screen.getByText("Open dialog");
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Confirm");
    // Focus moved to the first focusable inside the panel.
    const input = screen.getByLabelText("Name");
    expect(document.activeElement).toBe(input);
    // Tab from the last focusable wraps to the first…
    const shipIt = screen.getByRole("button", { name: "Ship it" });
    shipIt.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    // …and Shift+Tab from the first wraps to the last.
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(shipIt);
    // Esc closes; the exit animation runs BEFORE unmount.
    fireEvent.keyDown(dialog, { key: "Escape" });
    const panel = document.querySelector(".cat-dialog-panel");
    expect(panel).toBeInTheDocument();
    expect(document.querySelector(".cat-dialog-root")).toHaveAttribute(
      "data-state",
      "closing",
    );
    fireEvent.animationEnd(panel as Element);
    expect(document.querySelector(".cat-dialog-panel")).toBeNull();
    // Focus returns to the opener.
    expect(document.activeElement).toBe(opener);
  });

  it("closes on overlay pointerdown but not on panel clicks", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByText("Open dialog"));
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    const overlayHost = document.querySelector(".cat-dialog") as Element;
    fireEvent.pointerDown(overlayHost);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to a clock when animation events never arrive", () => {
    vi.useFakeTimers();
    try {
      render(<Host />);
      fireEvent.click(screen.getByText("Open dialog"));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(document.querySelector(".cat-dialog-panel")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(300)); // occluded windows throttle animation events
      expect(document.querySelector(".cat-dialog-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
