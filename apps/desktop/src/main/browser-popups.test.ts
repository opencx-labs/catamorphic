import { describe, expect, it } from "vitest";
import { guestWindowOpenAction } from "./browser-popups.js";

describe("guestWindowOpenAction", () => {
  it("keeps scripted popups as child windows so window.opener survives", () => {
    expect(
      guestWindowOpenAction({
        url: "https://accounts.google.com/gsi/select?client_id=x",
        disposition: "new-window",
      }),
    ).toBe("popup");
    expect(
      guestWindowOpenAction({ url: "about:blank", disposition: "new-window" }),
    ).toBe("popup");
  });

  it("opens ordinary new-tab links as workspace tabs", () => {
    for (const disposition of ["foreground-tab", "background-tab"]) {
      expect(
        guestWindowOpenAction({ url: "https://example.com/", disposition }),
      ).toBe("tab");
    }
  });

  it("denies non-web targets either way", () => {
    expect(
      guestWindowOpenAction({
        url: "javascript:alert(1)",
        disposition: "new-window",
      }),
    ).toBe("deny");
    expect(
      guestWindowOpenAction({
        url: "file:///etc/passwd",
        disposition: "foreground-tab",
      }),
    ).toBe("deny");
  });
});
