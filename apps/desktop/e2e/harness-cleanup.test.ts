import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeE2eDirectory } from "./harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("removeE2eDirectory", () => {
  it("retries transient Linux directory removal races", () => {
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    removeE2eDirectory("/tmp/catamorphic-e2e-data-test");

    expect(remove).toHaveBeenCalledWith("/tmp/catamorphic-e2e-data-test", {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
});
