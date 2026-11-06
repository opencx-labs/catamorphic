import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import type { AgentErrorKind } from "@catamorphic/agent-protocol";

/**
 * Provider failures as Claude Code reports them, by kind. Auth comes first:
 * an invalid key can also produce 4xx phrasings below.
 */
const KIND_SIGNATURES: Array<{ kind: AgentErrorKind; pattern: RegExp }> = [
  { kind: "auth", pattern: /\binvalid x-api-key\b/i },
  { kind: "auth", pattern: /\binvalid api key\b/i },
  { kind: "auth", pattern: /\bauthentication[_ ]error\b/i },
  { kind: "auth", pattern: /\bno auth credentials\b/i },
  { kind: "auth", pattern: /\bunauthorized\b/i },
  // An account sign-in whose access token expired and could not refresh.
  { kind: "auth", pattern: /\bfailed to authenticate\b/i },
  {
    kind: "auth",
    pattern: /\boauth\b.{0,80}\b(expired|revoked|invalid|refresh)/i,
  },
  { kind: "auth", pattern: /\b(token|session)\b.{0,40}\bexpired\b/i },
  { kind: "auth", pattern: /\bplease run \/login\b/i },
  // Reasoning signed by another model after a mid-conversation switch.
  { kind: "model_incompat", pattern: /\bsignature\b/i },
  { kind: "model_incompat", pattern: /\bthinking.{0,40}block/i },
  { kind: "rate_limit", pattern: /\brate.?limit/i },
  { kind: "rate_limit", pattern: /\b429\b/ },
  { kind: "rate_limit", pattern: /\btoo many requests\b/i },
  { kind: "rate_limit", pattern: /\bquota\b/i },
  { kind: "unavailable", pattern: /\boverloaded\b/i },
  { kind: "unavailable", pattern: /\b50[023]\b/ },
  { kind: "unavailable", pattern: /\bservice unavailable\b/i },
  { kind: "unavailable", pattern: /\binternal server error\b/i },
  { kind: "unavailable", pattern: /\bECONN(RESET|REFUSED)\b/ },
  { kind: "unavailable", pattern: /\bETIMEDOUT\b|\bENOTFOUND\b/ },
  { kind: "unavailable", pattern: /\bfetch failed\b/i },
];

/** The kind the SDK itself names on an API error's assistant message. */
const SDK_ERROR_KINDS: Partial<
  Record<SDKAssistantMessageError, AgentErrorKind>
> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  rate_limit: "rate_limit",
  overloaded: "unavailable",
  server_error: "unavailable",
};

/**
 * Classify a failed turn (ADR 0057's recovery kinds): the SDK's own error
 * tag when the CLI reported one, else the provider's words.
 */
export function classifyClaudeError(input: {
  message: string;
  sdkError?: SDKAssistantMessageError;
}): AgentErrorKind | undefined {
  const tagged = input.sdkError ? SDK_ERROR_KINDS[input.sdkError] : undefined;
  if (tagged) return tagged;
  // Tool output quotes arbitrary text: a 401 inside a curl the agent ran is
  // not this provider failing.
  if (input.message.startsWith("Tool ")) return undefined;
  return KIND_SIGNATURES.find(({ pattern }) => pattern.test(input.message))
    ?.kind;
}
