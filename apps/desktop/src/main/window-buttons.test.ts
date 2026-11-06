import { describe, expect, it, vi } from "vitest";
import { WindowButtons } from "./window-buttons.js";

function fakeWindow() {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setWindowButtonVisibility: vi.fn<(visible: boolean) => void>(),
  };
}

describe("WindowButtons", () => {
  it("hides a new window's buttons before it shows when the profile turned them off", () => {
    const window = fakeWindow();
    new WindowButtons({ allowed: () => false, platform: "darwin" }).manage(
      window,
    );
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
  });

  it("shows them only while both the preference and the workspace do", () => {
    let allowed = true;
    const window = fakeWindow();
    const buttons = new WindowButtons({
      allowed: () => allowed,
      platform: "darwin",
    });
    buttons.manage(window);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);

    // A collapsed sidebar holding the header hides them until revealed.
    buttons.request(window, false);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
    buttons.request(window, true);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);

    // The preference turns off: a reveal no longer brings them back.
    allowed = false;
    buttons.apply(window);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
    buttons.request(window, true);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);

    // Back on: the workspace's own choice holds.
    buttons.request(window, false);
    allowed = true;
    buttons.apply(window);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
    buttons.request(window, true);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
  });

  it("leaves windows it does not manage, closed windows and other platforms alone", () => {
    const unmanaged = fakeWindow();
    const buttons = new WindowButtons({
      allowed: () => true,
      platform: "darwin",
    });
    // The detached dock is frameless: showing buttons there would draw them.
    buttons.request(unmanaged, true);
    buttons.apply(unmanaged);
    expect(unmanaged.setWindowButtonVisibility).not.toHaveBeenCalled();

    const closed = fakeWindow();
    buttons.manage(closed);
    closed.setWindowButtonVisibility.mockClear();
    closed.destroyed = true;
    buttons.apply(closed);
    expect(closed.setWindowButtonVisibility).not.toHaveBeenCalled();

    const linux = fakeWindow();
    new WindowButtons({ allowed: () => false, platform: "linux" }).manage(
      linux,
    );
    expect(linux.setWindowButtonVisibility).not.toHaveBeenCalled();
  });
});
