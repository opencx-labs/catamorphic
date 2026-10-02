import type { AgentErrorKind, TurnError } from "@catamorphic/agent-protocol";

/**
 * Failure classification for chat turns. Provider errors reach the chat as
 * whatever the model API returned — OpenRouter's 401 body is literally
 * "User not found.", Anthropic says "invalid x-api-key" — which tells the
 * user nothing about what happened or what to do. {@link friendlyTurnError}
 * rewrites recognized failures into actionable messages (original quoted)
 * and stamps {@link AgentErrorKind} on the turn so the rest of
 * the stack can react: auth offers a re-connect path, rate-limit and
 * unavailable auto-retry with backoff, model-incompat retries with
 * sanitized history.
 */

const KIND_SIGNATURES: Array<{ kind: AgentErrorKind; pattern: RegExp }> = [
  // Auth first: an invalid key can also produce 4xx phrasings below.
  { kind: "auth", pattern: /\buser not found\b/i }, // OpenRouter 401
  { kind: "auth", pattern: /\binvalid x-api-key\b/i }, // Anthropic
  { kind: "auth", pattern: /\bauthentication[_ ]error\b/i },
  { kind: "auth", pattern: /\bincorrect api key\b/i }, // OpenAI
  { kind: "auth", pattern: /\binvalid api key\b/i },
  { kind: "auth", pattern: /\bno auth credentials\b/i },
  { kind: "auth", pattern: /\bunauthorized\b/i },
  // Claude Code / Codex account sessions: the CLI's OAuth access token
  // expired (≈8h life) and the refresh failed — e.g. after a long sleep,
  // or another client sharing the credentials rotated the refresh token.
  { kind: "auth", pattern: /\bfailed to authenticate\b/i },
  {
    kind: "auth",
    pattern: /\boauth\b.{0,80}\b(expired|revoked|invalid|refresh)/i,
  },
  { kind: "auth", pattern: /\b(token|session)\b.{0,40}\bexpired\b/i },
  { kind: "auth", pattern: /\bplease run \/login\b/i },
  // Mid-conversation model switches: reasoning/thinking output is signed
  // by the producing model; another model rejects the history.
  { kind: "model_incompat", pattern: /\bsignature\b/i },
  { kind: "model_incompat", pattern: /\bthinking.{0,40}block/i },
  { kind: "model_incompat", pattern: /\bencrypted.{0,20}(reasoning|content)/i },
  { kind: "model_incompat", pattern: /\breasoning.{0,40}not supported/i },
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

export function classifyAgentError(
  message: string,
): AgentErrorKind | undefined {
  // Tool failures quote arbitrary command/page output; a 401 or 429 inside
  // a curl the agent ran is not OUR provider failing.
  if (message.startsWith("Tool ")) return undefined;
  // A host-initiated interrupt is a user action, not a failure.
  if (/^interrupted\.?$/i.test(message.trim())) return undefined;
  if (/model requires a newer version of Codex/i.test(message))
    return undefined;
  return KIND_SIGNATURES.find(({ pattern }) => pattern.test(message))?.kind;
}

export function rewriteAgentError(
  kind: AgentErrorKind,
  agentName: string,
  providerLabel: string,
  original: string,
): string {
  const said = `(the provider said: "${truncate(original.trim(), 300)}")`;
  switch (kind) {
    case "auth":
      return (
        `${providerLabel} rejected the credentials of the "${agentName}" agent ` +
        `${said}. The session or key has likely expired or been revoked. ` +
        `Reconnect below or update it in Settings → Agents, and your message ` +
        `retries by itself once you're back. Or switch this chat to another agent.`
      );
    case "rate_limit":
      return (
        `${providerLabel} is rate-limiting the "${agentName}" agent ${said}. ` +
        `If a retry is safe, it will be scheduled below. Otherwise, check the last actions before retrying.`
      );
    case "unavailable":
      return (
        `${providerLabel} seems to be having trouble right now ${said}. ` +
        `If a retry is safe, it will be scheduled below. Otherwise, check the last actions before retrying.`
      );
    case "model_incompat":
      return (
        `The conversation history isn't compatible with the current model ` +
        `${said}. This usually happens after switching models mid-conversation. ` +
        `Retry repairs the history and continues.`
      );
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * A failed turn's error as the person reads it: recognized failures are
 * rewritten into something they can act on and classified, so the rest of
 * the stack can react (auth offers a reconnect, rate limits and outages
 * retry). Anything else passes through unchanged.
 */
export function friendlyTurnError({
  error,
  agentName,
  providerLabel,
}: {
  error: TurnError;
  agentName: string;
  providerLabel: string;
}): TurnError {
  const message = error.message;
  // A different native client owns this history. Retrying automatically or
  // silently re-anchoring it would bypass that client's ownership.
  if (
    providerLabel === "Codex" &&
    /^thread [0-9a-f-]+ already has an active writer$/i.test(message.trim())
  )
    return {
      message:
        "This chat is open in another Codex window or process. Close it there, then retry here. Your conversation is saved.",
    };
  if (
    providerLabel === "Codex" &&
    !message.startsWith("Tool ") &&
    /model requires a newer version of Codex/i.test(message)
  )
    return {
      message:
        "This model requires a newer Codex component. Choose another model in the command palette, or update Work and try again.",
    };
  const kind = error.kind ?? classifyAgentError(message);
  if (!kind) return error;
  return {
    ...error,
    kind,
    message: rewriteAgentError(kind, agentName, providerLabel, message),
  };
}
