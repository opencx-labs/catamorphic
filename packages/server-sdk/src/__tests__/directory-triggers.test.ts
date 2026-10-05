import { triggerKindInfo } from "@catamorphic/core";
import { describe, expect, it } from "vitest";
import {
  DIRECTORY_TRIGGER_KINDS,
  directoryGroupsChanged,
  directoryMemberJoined,
  directoryMemberLeft,
  directoryProjectEvent,
} from "../directory-trigger-kinds.js";

const member = { id: "user-1", email: "Ada@Example.com", name: "Ada" };

/** The envelope the dispatcher delivers as workflow input. */
function delivered(event: ReturnType<typeof directoryProjectEvent>) {
  return {
    id: "event-1",
    sequence: 7,
    projectId: "project-1",
    source: event.source,
    kind: event.kind,
    externalId: event.externalId,
    occurredAt: event.occurredAt,
    receivedAt: event.occurredAt,
    payload: event.payload,
  };
}

describe("directory trigger kinds (ADR 0209)", () => {
  it("builds one idempotent event per transition, with the member's domain and normalized groups", () => {
    const joined = directoryProjectEvent({
      kind: "directory.member-joined",
      member,
      groups: ["Eng@Example.com ", "all@example.com", "eng@example.com"],
      occurredAt: new Date("2026-10-06T09:00:00Z"),
      revision: 1,
    });
    expect(joined).toEqual({
      source: "directory",
      kind: "directory.member-joined",
      externalId: "directory.member-joined:user-1:1",
      occurredAt: "2026-10-06T09:00:00.000Z",
      payload: {
        member: {
          id: "user-1",
          email: "ada@example.com",
          name: "Ada",
          domain: "example.com",
        },
        groups: ["all@example.com", "eng@example.com"],
      },
    });
    expect(directoryMemberJoined.validatePayload(delivered(joined))).toEqual({
      ok: true,
    });
    // A transition replayed has the same identity; a later one is new.
    expect(
      directoryProjectEvent({
        kind: "directory.member-joined",
        member,
        groups: [],
        occurredAt: new Date(),
        revision: 1,
      }).externalId,
    ).toBe(joined.externalId);
    expect(
      directoryProjectEvent({
        kind: "directory.member-left",
        member: { ...member, name: "" },
        groups: [],
        occurredAt: new Date(),
        revision: 2,
      }),
    ).toMatchObject({
      externalId: "directory.member-left:user-1:2",
      payload: { member: { name: null } },
    });
  });

  it("narrows joins and departures to members of a group, and changes to the groups they touch", () => {
    for (const kind of [directoryMemberJoined, directoryMemberLeft]) {
      const payload = delivered(
        directoryProjectEvent({
          kind:
            kind === directoryMemberJoined
              ? "directory.member-joined"
              : "directory.member-left",
          member,
          groups: ["eng@example.com"],
          occurredAt: new Date(),
          revision: 1,
        }),
      );
      expect(kind.matches?.({ config: {}, payload })).toBe(true);
      expect(
        kind.matches?.({
          config: { groups: ["sales@example.com", "ENG@example.com"] },
          payload,
        }),
      ).toBe(true);
      expect(
        kind.matches?.({ config: { groups: ["sales@example.com"] }, payload }),
      ).toBe(false);
    }
    const changed = delivered(
      directoryProjectEvent({
        kind: "directory.groups-changed",
        member,
        groups: ["eng@example.com", "oncall@example.com"],
        added: ["oncall@example.com"],
        removed: ["sales@example.com"],
        occurredAt: new Date(),
        revision: 3,
      }),
    );
    expect(directoryGroupsChanged.validatePayload(changed)).toEqual({
      ok: true,
    });
    const matches = (groups: string[]) =>
      directoryGroupsChanged.matches?.({
        config: { groups },
        payload: changed,
      });
    expect(matches(["oncall@example.com"])).toBe(true);
    expect(matches(["sales@example.com"])).toBe(true);
    // Still a member, but this change is not about that group.
    expect(matches(["eng@example.com"])).toBe(false);
  });

  it("refuses other sources and unknown config, and asks subscribers for memberships:read", () => {
    const joined = delivered(
      directoryProjectEvent({
        kind: "directory.member-joined",
        member,
        groups: [],
        occurredAt: new Date(),
        revision: 1,
      }),
    );
    expect(
      directoryMemberJoined.validatePayload({ ...joined, source: "webhook" })
        .ok,
    ).toBe(false);
    expect(directoryMemberLeft.validatePayload(joined).ok).toBe(false);
    expect(directoryMemberJoined.validateConfig({ groups: [] }).ok).toBe(false);
    expect(directoryMemberJoined.validateConfig({ domain: "x" }).ok).toBe(
      false,
    );
    expect(
      DIRECTORY_TRIGGER_KINDS.map((kind) => ({
        name: kind.name,
        modes: kind.modes,
        requiredPermissions: triggerKindInfo(kind).requiredPermissions,
      })),
    ).toEqual(
      [
        "directory.member-joined",
        "directory.member-left",
        "directory.groups-changed",
      ].map((name) => ({
        name,
        modes: ["async"],
        requiredPermissions: ["memberships:read"],
      })),
    );
  });
});
