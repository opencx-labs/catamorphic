import type { JsonObject } from "@catamorphic/db";
import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

/** The project event source directory events carry (ADR 0210). */
export const DIRECTORY_EVENT_SOURCE = "directory";

/** The directory's three transitions, as trigger kind names. */
export const DIRECTORY_EVENT_KINDS = [
  "directory.member-joined",
  "directory.member-left",
  "directory.groups-changed",
] as const;

export type DirectoryEventKind = (typeof DIRECTORY_EVENT_KINDS)[number];

/** The person a directory event is about. */
export interface DirectoryMember {
  /** Their user id: what memberships and `catamorphic.secrets` name. */
  id: string;
  email: string;
  name: string | null;
}

const member = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  /** The email's domain, lowercased, so `where` can select a domain. */
  domain: z.string(),
});

const membership = z.object({
  member,
  /** Their directory groups among those the host tracks, lowercased. */
  groups: z.array(z.string()),
});

const groupChange = membership.extend({
  /** Groups they joined since the last answer. */
  added: z.array(z.string()),
  /** Groups they left since the last answer. */
  removed: z.array(z.string()),
});

/** The Project Event envelope the dispatcher delivers as workflow input. */
function envelope<Payload extends z.ZodType>(
  kind: DirectoryEventKind,
  payload: Payload,
) {
  return z.object({
    id: z.string(),
    sequence: z.number(),
    projectId: z.string(),
    source: z.literal(DIRECTORY_EVENT_SOURCE),
    kind: z.literal(kind),
    externalId: z.string(),
    occurredAt: z.string(),
    receivedAt: z.string(),
    payload,
  });
}

const config = z.strictObject({
  /**
   * Only members of any of these groups (joined, left), or only changes
   * that add or remove one of them (groups changed).
   */
  groups: z.array(z.string()).min(1).optional(),
});

const PERMISSIONS = ["memberships:read"] as const;

const NARROWING =
  "Config groups narrows to members of any of those groups; where on payload.member.domain selects one email domain. A subscribing workflow must declare memberships:read.";

/**
 * A member's account became active (ADR 0210): their first sign-in, or a
 * sign-in the directory approves after it was disabled.
 */
export const directoryMemberJoined = defineTriggerKind({
  name: "directory.member-joined",
  modes: ["async"],
  display: { label: "member joined", icon: "user-plus" },
  description: `A member's account became active: their first sign-in, or a sign-in the directory approves after it was disabled. input.payload.member names them (id, email, name, domain) and input.payload.groups lists their directory groups. ${NARROWING}`,
  payload: envelope("directory.member-joined", membership),
  config,
  requiredPermissions: PERMISSIONS,
  correlationKey: (event) => event.id,
  matches: ({ config, payload: event }) =>
    inAnyGroup({ wanted: config.groups, groups: event.payload.groups }),
});

/**
 * A member's account was disabled (ADR 0210): the directory reports them
 * suspended, deleted or outside every required group.
 */
export const directoryMemberLeft = defineTriggerKind({
  name: "directory.member-left",
  modes: ["async"],
  display: { label: "member left", icon: "user-minus" },
  description: `A member's account was disabled: the directory reports them suspended, deleted, or outside every required group. input.payload.member names them and input.payload.groups lists the groups they last held. ${NARROWING}`,
  payload: envelope("directory.member-left", membership),
  config,
  requiredPermissions: PERMISSIONS,
  correlationKey: (event) => event.id,
  matches: ({ config, payload: event }) =>
    inAnyGroup({ wanted: config.groups, groups: event.payload.groups }),
});

/** An active member's directory groups changed (ADR 0210). */
export const directoryGroupsChanged = defineTriggerKind({
  name: "directory.groups-changed",
  modes: ["async"],
  display: { label: "groups changed", icon: "users" },
  description:
    "An active member's directory groups changed. input.payload.added and input.payload.removed name the change and input.payload.groups their groups now. Config groups narrows to changes that add or remove one of those groups; where on payload.member.domain selects one email domain. A subscribing workflow must declare memberships:read.",
  payload: envelope("directory.groups-changed", groupChange),
  config,
  requiredPermissions: PERMISSIONS,
  correlationKey: (event) => event.id,
  matches: ({ config, payload: event }) =>
    inAnyGroup({
      wanted: config.groups,
      groups: [...event.payload.added, ...event.payload.removed],
    }),
});

/**
 * The directory trigger kinds. A host registers them in `triggerKinds` and
 * appends {@link directoryProjectEvent}s as its accounts change; the Work
 * server does both for every `DirectoryProvider`.
 */
export const DIRECTORY_TRIGGER_KINDS = [
  directoryMemberJoined,
  directoryMemberLeft,
  directoryGroupsChanged,
];

type DirectoryTransition =
  | {
      kind: "directory.member-joined" | "directory.member-left";
      member: DirectoryMember;
      groups: readonly string[];
    }
  | {
      kind: "directory.groups-changed";
      member: DirectoryMember;
      groups: readonly string[];
      added: readonly string[];
      removed: readonly string[];
    };

/**
 * The project event for one directory transition, ready for
 * `core.projectEvents.appendToSubscribers`. `revision` counts the
 * account's transitions, so a replay of the same transition has the same
 * external id and is stored once, while a later one is new.
 */
export function directoryProjectEvent(
  args: DirectoryTransition & { occurredAt: Date; revision: number },
): {
  source: typeof DIRECTORY_EVENT_SOURCE;
  kind: DirectoryEventKind;
  externalId: string;
  occurredAt: string;
  payload: JsonObject;
} {
  const email = args.member.email.toLowerCase();
  const payload: JsonObject = {
    member: {
      id: args.member.id,
      email,
      name: args.member.name || null,
      domain: email.slice(email.lastIndexOf("@") + 1),
    },
    groups: normalized(args.groups),
    ...(args.kind === "directory.groups-changed"
      ? { added: normalized(args.added), removed: normalized(args.removed) }
      : {}),
  };
  return {
    source: DIRECTORY_EVENT_SOURCE,
    kind: args.kind,
    externalId: `${args.kind}:${args.member.id}:${args.revision}`,
    occurredAt: args.occurredAt.toISOString(),
    payload,
  };
}

function normalized(groups: readonly string[]): string[] {
  return [...new Set(groups.map(normalizeGroup))].sort();
}

function normalizeGroup(group: string): string {
  return group.trim().toLowerCase();
}

function inAnyGroup(args: {
  wanted: readonly string[] | undefined;
  groups: readonly string[];
}): boolean {
  if (!args.wanted) return true;
  const groups = new Set(args.groups.map(normalizeGroup));
  return args.wanted.some((group) => groups.has(normalizeGroup(group)));
}
