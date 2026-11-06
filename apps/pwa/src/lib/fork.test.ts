import type { Item, NoticeItem } from "@catamorphic/react";
import { describe, expect, it } from "vitest";
import { mirrorForkNotice } from "./fork.js";

const AT = "2026-10-01T10:00:00.000Z";

function notice(code: string, data: NoticeItem["data"]): Item {
  return {
    id: `notice-${code}`,
    sessionId: "s-local",
    turnId: null,
    attemptId: null,
    parentItemId: null,
    position: 1,
    status: "completed",
    nativeRef: null,
    createdAt: AT,
    updatedAt: AT,
    startedAt: AT,
    endedAt: AT,
    kind: "notice",
    code,
    text: "This conversation continued on another server.",
    data,
  };
}

describe("mirrorForkNotice", () => {
  it("finds the mirror fork notice among the items", () => {
    expect(
      mirrorForkNotice([
        notice("agent_changed", { agentId: "helper" }),
        notice("mirror_fork", {
          serverUrl: "https://brain.acme.dev/api",
          remoteProjectId: "p-r",
          sessionId: "s-1",
        }),
      ]),
    ).toEqual({
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "p-r",
      sessionId: "s-1",
    });
  });

  it("ignores other notices and malformed ones", () => {
    expect(
      mirrorForkNotice([
        notice("agent_changed", {}),
        notice("mirror_fork", { serverUrl: "https://brain.acme.dev/api" }),
      ]),
    ).toBeNull();
    expect(mirrorForkNotice([])).toBeNull();
  });
});
