import { createHash } from "node:crypto";
import {
  type Identity,
  isBuilder,
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
 * Whose keyed chat a workflow reaches (ADR 0156). A member's automation
 * reaches its member's chat. A project automation reaches the project chat,
 * or a named member's. A run started by hand acts for its caller, and only
 * a builder may reach the project chat from one.
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
  const project = () => {
    // A project automation's run already acts as the project, with its
    // consented connections; a builder's hand-started run gets a bare one.
    if (isProjectPrincipal(caller.externalUserId)) return caller;
    if (!input.environment)
      throw new Error("A project chat needs an Environment to run in");
    return projectPrincipalIdentity({
      tenantId: caller.tenantId,
      projectId: input.projectId,
      environment: input.environment,
    });
  };
  if (enablement?.owner_kind === "member") {
    if (
      audience === "project" ||
      (audience && audience.member !== enablement.owner_external_user_id)
    )
      throw new Error(
        "A member's automation reaches only that member's chat; enable it for the project to reach others",
      );
    return caller;
  }
  if (enablement?.owner_kind === "project") {
    if (!audience || audience === "project") return project();
    const member = await input.resolveMember({
      tenantId: caller.tenantId,
      projectId: input.projectId,
      externalUserId: audience.member,
    });
    if (!member)
      throw new Error(`${audience.member} is not a member of this project`);
    return member;
  }
  if (audience === "project") {
    if (!isBuilder(caller, input.projectId)) throw new AccessDeniedError();
    return project();
  }
  if (audience && audience.member !== caller.externalUserId)
    throw new Error("A run started by hand reaches only its caller's chat");
  return caller;
}
