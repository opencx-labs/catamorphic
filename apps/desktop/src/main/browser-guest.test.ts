import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { BROWSER_GUEST } from "./browser-guest.js";

it("initializes on failed loads and HTTP pages without secure-context crypto APIs", () => {
  // These worlds expose getRandomValues but not randomUUID. Even clearing
  // a page's pointers initializes the guest, before any snapshot is read.
  const result: unknown = runInNewContext(
    `${BROWSER_GUEST}; typeof catamorphicBrowser.clear`,
    {
      crypto: {
        getRandomValues: (values: Uint32Array<ArrayBuffer>) =>
          webcrypto.getRandomValues(values),
      },
      ResizeObserver: class {},
      MutationObserver: class {},
    },
  );
  expect(result).toBe("function");
});
