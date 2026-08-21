import { describe, expect, it } from "vitest";
import { mirrorForkNotice } from "./fork.js";

describe("mirrorForkNotice", () => {
  it("finds the fork marker among system rows", () => {
    const notice = mirrorForkNotice([
      { role: "user", metadata: null },
      {
        role: "system",
        metadata: {
          marker: {
            kind: "mirror_fork",
            serverUrl: "https://brain.acme.dev/api",
            remoteProjectId: "p-r",
            sessionId: "s-1",
          },
        },
      },
    ]);
    expect(notice).toEqual({
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "p-r",
      sessionId: "s-1",
    });
  });

  it("ignores other markers and malformed ones", () => {
    expect(
      mirrorForkNotice([
        { role: "system", metadata: { marker: { kind: "agent_change" } } },
        { role: "system", metadata: { marker: { kind: "mirror_fork" } } },
      ]),
    ).toBeNull();
    expect(mirrorForkNotice([])).toBeNull();
  });
});
