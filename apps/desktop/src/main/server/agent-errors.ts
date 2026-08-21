import type {
  AgentErrorKind,
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";

/**
 * Failure classification for chat turns. Provider errors reach the chat as
 * whatever the model API returned — OpenRouter's 401 body is literally
 * "User not found.", Anthropic says "invalid x-api-key" — which tells the
 * user nothing about what happened or what to do. This decorator rewrites
 * recognized failures into actionable messages (original preserved for
 * debugging) and stamps {@link AgentErrorKind} on the event so the rest of
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
        `Reconnect below or update it in Settings → Agents — your message ` +
        `retries by itself once you're back. Or switch this chat to another agent.`
      );
    case "rate_limit":
      return (
        `${providerLabel} is rate-limiting the "${agentName}" agent ${said}. ` +
        `I'll keep retrying automatically, or switch this chat to another agent.`
      );
    case "unavailable":
      return (
        `${providerLabel} seems to be having trouble right now ${said}. ` +
        `I'll keep retrying automatically, or switch this chat to another agent.`
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
 * Wraps a provider; error events get classified and rewritten. interrupt
 * and retryTurn forward only when the wrapped harness supports them —
 * hosts feature-detect by method presence, so a decorator must not
 * fabricate support the harness doesn't have.
 */
export class FriendlyAgentErrors implements CodingAgentProvider {
  readonly name: string;
  readonly interrupt?: (providerSessionId: string) => void;
  readonly hasSession?: (providerSessionId: string) => boolean;
  readonly retryTurn?: (
    session: ProviderSession,
    opts?: TurnOptions & { sanitizeReasoning?: boolean },
  ) => AsyncIterable<AgentEvent>;

  constructor(
    private readonly inner: CodingAgentProvider,
    private readonly agentName: string,
    private readonly providerLabel: string,
  ) {
    this.name = inner.name;
    if (inner.interrupt) {
      this.interrupt = (providerSessionId) =>
        inner.interrupt?.(providerSessionId);
    }
    if (inner.hasSession) {
      this.hasSession = (providerSessionId) =>
        inner.hasSession?.(providerSessionId) ?? true;
    }
    if (inner.retryTurn) {
      this.retryTurn = (session, opts) =>
        this.mapErrors(
          (inner.retryTurn as NonNullable<typeof inner.retryTurn>).call(
            inner,
            session,
            opts,
          ),
        );
    }
  }

  startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return this.inner.startSession(opts);
  }

  sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    return this.mapErrors(this.inner.sendMessage(session, message, opts));
  }

  dispose(session: ProviderSession): Promise<void> {
    return this.inner.dispose(session);
  }

  private async *mapErrors(
    events: AsyncIterable<AgentEvent>,
  ): AsyncIterable<AgentEvent> {
    for await (const event of events) {
      if (event.type === "error" && event.content) {
        const kind = event.errorKind ?? classifyAgentError(event.content);
        if (kind) {
          yield {
            ...event,
            errorKind: kind,
            content: rewriteAgentError(
              kind,
              this.agentName,
              this.providerLabel,
              event.content,
            ),
          };
          continue;
        }
      }
      yield event;
    }
  }
}
