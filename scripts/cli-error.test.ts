import { describe, expect, it } from "vitest";
import { writeCliError } from "./cli-error.js";

describe("writeCliError", () => {
  it("writes every recursively nested AggregateError message to stderr", () => {
    const chunks: string[] = [];
    const error = new AggregateError(
      [
        new Error("workspace tests exited with code 1"),
        new AggregateError(
          [new Error("docker stop failed"), "docker diagnostics unavailable"],
          "cleanup failed",
        ),
      ],
      "Disposable Postgres task and cleanup both failed",
    );

    writeCliError(error, {
      write(chunk) {
        chunks.push(chunk);
      },
    });

    expect(chunks.join("")).toBe(
      [
        "Disposable Postgres task and cleanup both failed",
        "  - workspace tests exited with code 1",
        "  - cleanup failed",
        "    - docker stop failed",
        "    - docker diagnostics unavailable",
        "",
      ].join("\n"),
    );
  });
});
