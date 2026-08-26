import { describe, expect, it, vi } from "vitest";
import { githubCliToken } from "./github-cli.js";

describe("githubCliToken", () => {
  it("reads the authenticated github.com token without using gh for API work", async () => {
    const run = vi.fn(async () => ({ stdout: "gho_from_cli\n" }));

    await expect(githubCliToken({ run })).resolves.toBe("gho_from_cli");
    expect(run).toHaveBeenCalledWith("gh", [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
  });

  it("returns null when gh is absent, signed out, or returns no token", async () => {
    await expect(
      githubCliToken({
        run: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).resolves.toBeNull();
    await expect(
      githubCliToken({ run: async () => ({ stdout: "  \n" }) }),
    ).resolves.toBeNull();
  });
});
