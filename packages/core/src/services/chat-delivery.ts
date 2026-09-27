import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EVERY_ARTIFACT,
  hasProjectPermission,
  type Identity,
  isProjectPrincipal,
  PROJECT_PRINCIPAL_ID,
  projectPrincipalIdentity,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";

/** Whose keyed chat a delivery reaches (ADR 0156). */
export type ChatAudience = "project" | { member: string };

/**
 * A chat key (ADR 0173): the project's name for one open chat, such as
 * `pr-42`. Any automation in the project may use it; 1 to 200 characters,
 * no control characters.
 */
export const ChatKeySchema = z
  .string()
  .trim()
  .min(1, "key must not be empty")
  .max(200, "key must be at most 200 characters")
  .regex(/^[^\p{Cc}]+$/u, "key must not contain control characters");

export const ChatAudienceSchema = z.union([
  z.literal("project"),
  z.strictObject({ member: z.string().trim().min(1) }),
]);

/** Validate a chat key, with a readable error. */
export function parseChatKey(value: unknown): string {
  const parsed = ChatKeySchema.safeParse(value);
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid key");
  return parsed.data;
}

/**
 * Whose open chat a key names when a caller looks it up (ADR 0173): the
 * project chat for `audience: "project"` or a project principal caller, a
 * named member's, or otherwise the caller's own. Lookup grants nothing;
 * reading or changing the chat checks access as usual.
 */
export function keyedChatOwnerId(input: {
  caller: Identity;
  audience: ChatAudience | undefined;
}): string {
  if (input.audience === "project") return PROJECT_PRINCIPAL_ID;
  if (input.audience) return input.audience.member;
  return input.caller.externalUserId;
}

/**
 * Who answers the chat's escalations while no one watches it (ADR 0176):
 * named members and holders of named project roles.
 */
export interface ChatApprovers {
  members?: string[];
  roles?: string[];
}

type DeliveryMessage = {
  content: string;
  mode: "message_only" | "next_turn" | "interrupt";
  attention?: "required" | "none";
  notification?: { title?: string; body?: string };
  idempotencyKey?: string;
  approvers?: ChatApprovers;
};

/** `catamorphic.sessions.deliver`, validated: a chat by id or by key. */
export type ChatDelivery = DeliveryMessage &
  (
    | { sessionId: string }
    | {
        key: string;
        audience?: ChatAudience;
        agentSlug?: string;
        title?: string;
        environment?: string;
      }
  );

/**
 * Validate a workflow's `deliver` call. Exactly one of `sessionId` and
 * `key` names the chat; the keyed options apply only to `key`.
 */
export function parseChatDelivery(value: unknown): ChatDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("catamorphic.sessions.deliver expects an object");
  const input: Record<string, unknown> = { ...value };
  const text = (name: string, max: number, required = false) => {
    const item = input[name];
    if (item === undefined && !required) return undefined;
    if (typeof item !== "string" || !item.trim() || item.length > max)
      throw new Error(
        `${name} must be a non-empty string up to ${max} characters`,
      );
    return item.trim();
  };
  const content = input.content;
  if (typeof content !== "string" || !content.trim())
    throw new Error("content must be a non-empty string");
  const mode = input.mode ?? "next_turn";
  if (mode !== "message_only" && mode !== "next_turn" && mode !== "interrupt")
    throw new Error("mode must be message_only, next_turn, or interrupt");
  const attention = input.attention;
  if (
    attention !== undefined &&
    attention !== "none" &&
    attention !== "required"
  )
    throw new Error("attention must be none or required");
  const notification = parseNotification(input.notification);
  const idempotencyKey = text("idempotencyKey", 500);
  const approvers = parseApprovers(input.approvers);
  const common: DeliveryMessage = {
    content,
    mode,
    ...(attention ? { attention } : {}),
    ...(notification ? { notification } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(approvers ? { approvers } : {}),
  };

  const hasSession = input.sessionId !== undefined;
  const hasKey = input.key !== undefined;
  if (hasSession === hasKey)
    throw new Error("Name the chat with exactly one of sessionId or key");
  if (hasSession) {
    for (const keyed of ["audience", "agentSlug", "title", "environment"])
      if (input[keyed] !== undefined)
        throw new Error(`${keyed} applies only to a chat named by key`);
    const sessionId = text("sessionId", 100, true);
    if (!sessionId) throw new Error("sessionId must be a non-empty string");
    return { ...common, sessionId };
  }
  const key = parseChatKey(input.key);
  const audience = parseAudience(input.audience);
  const agentSlug = text("agentSlug", 255);
  const title = text("title", 500);
  const environment = text("environment", 255);
  return {
    ...common,
    key,
    ...(audience ? { audience } : {}),
    ...(agentSlug ? { agentSlug } : {}),
    ...(title ? { title } : {}),
    ...(environment ? { environment } : {}),
  };
}

function parseAudience(value: unknown): ChatAudience | undefined {
  if (value === undefined) return undefined;
  const parsed = ChatAudienceSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('audience must be "project" or { member: "<user id>" }');
  return parsed.data;
}

export function parseApprovers(value: unknown): ChatApprovers | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      'approvers must be { members?: ["<user id>"], roles?: ["<role>"] }',
    );
  const list = (name: "members" | "roles") => {
    const item = name in value ? Reflect.get(value, name) : undefined;
    if (item === undefined) return undefined;
    if (
      !Array.isArray(item) ||
      item.length > 50 ||
      item.some(
        (entry) =>
          typeof entry !== "string" || !entry.trim() || entry.length > 200,
      )
    )
      throw new Error(`approvers.${name} must be up to 50 non-empty strings`);
    return [...new Set(item.map((entry) => String(entry).trim()))];
  };
  const members = list("members");
  const roles = list("roles");
  if (!members?.length && !roles?.length)
    throw new Error("approvers must name at least one member or role");
  return {
    ...(members?.length ? { members } : {}),
    ...(roles?.length ? { roles } : {}),
  };
}

function parseNotification(
  value: unknown,
): { title?: string; body?: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("notification must be an object");
  const field = (name: "title" | "body", max: number) => {
    const item = name in value ? Reflect.get(value, name) : undefined;
    if (item === undefined) return undefined;
    if (typeof item !== "string" || !item.trim() || item.length > max)
      throw new Error(
        `notification.${name} must be a non-empty string up to ${max} characters`,
      );
    return item.trim();
  };
  const title = field("title", 200);
  const body = field("body", 500);
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
}

/**
 * One delivery per run, chat and content unless the workflow says
 * otherwise: a retried boundary never posts twice, and two different
 * messages in one run both arrive.
 */
export function defaultDeliveryKey(input: {
  runId: string;
  chat: string;
  content: string;
}): string {
  const digest = createHash("sha256")
    .update(input.content)
    .digest("hex")
    .slice(0, 16);
  return `workflow:${input.runId}:${input.chat}:${digest}`;
}

/**
 * Whose keyed chat a workflow reaches (ADR 0156, 0158). A project
 * automation reaches the project chat, or a named member's. Any other run
 * acts for its caller: the caller's own chat, the project chat with
 * `automations:write`, or another member's with `sessions:write`, each a
 * permission the workflow declares (the run holds nothing else).
 *
 * The chat is placed by its own Environment, never the run's (ADR 0173):
 * a member's chat in the Environments their roles grant, a project chat in
 * any Environment the project declares. The chat's agent policy
 * (`environment.allowed`) and the machines open to its owner decide the rest.
 */
export async function chatOwner(input: {
  /** The run's caller: the enablement's owner, or whoever started it. */
  caller: Identity;
  projectId: string;
  audience: ChatAudience | undefined;
  enablement:
    | { owner_kind: string; owner_external_user_id: string | null }
    | undefined;
  resolveMember(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
  }): Promise<Identity | null>;
}): Promise<Identity> {
  const { caller, audience, enablement } = input;
  const member = async (externalUserId: string) => {
    const found = await input.resolveMember({
      tenantId: caller.tenantId,
      projectId: input.projectId,
      externalUserId,
    });
    if (!found)
      throw new Error(`${externalUserId} is not a member of this project`);
    return found;
  };
  // The project's own chats may run in any Environment the project declares.
  const projectChat = (principal: Identity): Identity => ({
    ...principal,
    executionScope: [{ projectId: input.projectId, name: EVERY_ARTIFACT }],
  });
  if (enablement?.owner_kind === "project") {
    // A project automation's run already acts as the project, with its
    // consented connections.
    if (!audience || audience === "project") return projectChat(caller);
    return member(audience.member);
  }
  if (audience === "project") {
    if (!hasProjectPermission(caller, input.projectId, "automations:write"))
      throw new AccessDeniedError(
        "Reaching the project chat needs the automations:write permission; turn the workflow on for the project instead",
      );
    if (isProjectPrincipal(caller.externalUserId)) return projectChat(caller);
    return projectChat(
      projectPrincipalIdentity({
        tenantId: caller.tenantId,
        projectId: input.projectId,
        environment: EVERY_ARTIFACT,
      }),
    );
  }
  if (!audience || audience.member === caller.externalUserId) return caller;
  if (!hasProjectPermission(caller, input.projectId, "sessions:write"))
    throw new AccessDeniedError(
      `Reaching ${audience.member}'s chat needs the sessions:write permission`,
    );
  return member(audience.member);
}
