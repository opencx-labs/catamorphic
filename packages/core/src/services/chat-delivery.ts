import { createHash } from "node:crypto";
import {
  hasProjectPermission,
  type Identity,
  isProjectPrincipal,
  projectPrincipalIdentity,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";

/** Whose keyed chat a delivery reaches (ADR 0156). */
export type ChatAudience = "project" | { member: string };

type DeliveryMessage = {
  content: string;
  mode: "message_only" | "next_turn" | "interrupt";
  attention?: "required" | "none";
  notification?: { title?: string; body?: string };
  idempotencyKey?: string;
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

const KEY_MAX = 200;

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
  const common: DeliveryMessage = {
    content,
    mode,
    ...(attention ? { attention } : {}),
    ...(notification ? { notification } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
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
  const key = text("key", KEY_MAX, true);
  if (!key) throw new Error("key must be a non-empty string");
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
  if (value === "project") return "project";
  if (
    value &&
    typeof value === "object" &&
    "member" in value &&
    typeof value.member === "string" &&
    value.member.trim()
  )
    return { member: value.member.trim() };
  throw new Error('audience must be "project" or { member: "<user id>" }');
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
 */
export async function chatOwner(input: {
  /** The run's caller: the enablement's owner, or whoever started it. */
  caller: Identity;
  projectId: string;
  audience: ChatAudience | undefined;
  enablement:
    | { owner_kind: string; owner_external_user_id: string | null }
    | undefined;
  environment: string | undefined;
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
  if (enablement?.owner_kind === "project") {
    // A project automation's run already acts as the project, with its
    // consented connections.
    if (!audience || audience === "project") return caller;
    return member(audience.member);
  }
  if (audience === "project") {
    if (!hasProjectPermission(caller, input.projectId, "automations:write"))
      throw new AccessDeniedError(
        "Reaching the project chat needs the automations:write permission; turn the workflow on for the project instead",
      );
    if (isProjectPrincipal(caller.externalUserId)) return caller;
    if (!input.environment)
      throw new Error("A project chat needs an Environment to run in");
    return projectPrincipalIdentity({
      tenantId: caller.tenantId,
      projectId: input.projectId,
      environment: input.environment,
    });
  }
  if (!audience || audience.member === caller.externalUserId) return caller;
  if (!hasProjectPermission(caller, input.projectId, "sessions:write"))
    throw new AccessDeniedError(
      `Reaching ${audience.member}'s chat needs the sessions:write permission`,
    );
  return member(audience.member);
}
