import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";

export {
  PROJECT_AGENT_ID_PREFIX,
  parseProjectAgentId,
  projectAgentId,
} from "@catamorphic/core";

/**
 * Prepends the agent's persona file (`agents/<slug>.md`) to the session
 * system prompt — the persona leads, the host's standing prompt and
 * playbooks follow. Optional harness methods are mirrored, never
 * fabricated (hosts feature-detect by method presence).
 */
export class PersonaCodingAgent implements CodingAgentProvider {
  readonly name: string;
  readonly interrupt?: (providerSessionId: string) => void;
  readonly hasSession?: (providerSessionId: string) => boolean;
  readonly retryTurn?: CodingAgentProvider["retryTurn"];

  constructor(
    private readonly inner: CodingAgentProvider,
    private readonly persona: string,
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
        (inner.retryTurn as NonNullable<typeof inner.retryTurn>).call(
          inner,
          session,
          opts,
        );
    }
  }

  startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return this.inner.startSession({
      ...opts,
      systemPrompt: [this.persona, opts.systemPrompt]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    return this.inner.sendMessage(session, message, opts);
  }

  dispose(session: ProviderSession): Promise<void> {
    return this.inner.dispose(session);
  }
}

/**
 * A provider that cannot run — an unconsented, invalid, or unsupported
 * project agent — but must never hang or crash a turn. Anchoring succeeds
 * (a metadata write) and the first message comes back as a clear,
 * actionable error event. Its name never matches a real harness, so once
 * the blocker clears the session re-anchors on the real provider.
 */
export class FailFastCodingAgent implements CodingAgentProvider {
  readonly name = "project-agent-unavailable";

  constructor(private readonly message: string) {}

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return {
      providerSessionId: `unavailable-${opts.sessionId}`,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(): AsyncIterable<AgentEvent> {
    yield { type: "error", content: this.message };
    yield { type: "done" };
  }

  async dispose(): Promise<void> {}
}

/** Which optional provider methods a wrapped harness kind is known to have. */
export interface AsyncInitCapabilities {
  interrupt?: boolean;
  hasSession?: boolean;
  retryTurn?: boolean;
}

/**
 * Defers provider construction until the first session/turn needs it — how
 * secret-credentialed project agents work: `registry.get()` is synchronous,
 * but the project secret resolves through core's async SecretsService. The
 * factory runs once and is retried on failure (a secret set after the
 * first attempt is picked up on the next turn); a factory that cannot
 * produce a provider returns a {@link FailFastCodingAgent} so the turn
 * errors actionably instead of hanging.
 *
 * Optional methods are declared from the harness KIND (statically known),
 * not the not-yet-built instance, so host feature-detection stays honest.
 */
export class AsyncInitCodingAgent implements CodingAgentProvider {
  readonly name: string;
  readonly interrupt?: (providerSessionId: string) => void;
  readonly hasSession?: (providerSessionId: string) => boolean;
  readonly retryTurn?: CodingAgentProvider["retryTurn"];

  private innerPromise?: Promise<CodingAgentProvider>;
  private innerResolved?: CodingAgentProvider;

  constructor(
    name: string,
    private readonly factory: () => Promise<CodingAgentProvider>,
    capabilities: AsyncInitCapabilities,
  ) {
    this.name = name;
    if (capabilities.interrupt) {
      this.interrupt = (providerSessionId) =>
        this.innerResolved?.interrupt?.(providerSessionId);
    }
    if (capabilities.hasSession) {
      // No live inner provider → no live session (accurate: in-memory
      // harness state cannot predate its own construction).
      this.hasSession = (providerSessionId) =>
        this.innerResolved?.hasSession?.(providerSessionId) ?? false;
    }
    if (capabilities.retryTurn) {
      this.retryTurn = (session, opts) => this.retryStream(session, opts);
    }
  }

  private inner(): Promise<CodingAgentProvider> {
    this.innerPromise ??= this.factory().then(
      (provider) => {
        this.innerResolved = provider;
        return provider;
      },
      (cause) => {
        // Don't cache the failure: the next turn retries the factory.
        this.innerPromise = undefined;
        return new FailFastCodingAgent(
          cause instanceof Error ? cause.message : String(cause),
        );
      },
    );
    return this.innerPromise;
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return (await this.inner()).startSession(opts);
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    const inner = await this.inner();
    yield* inner.sendMessage(session, message, opts);
  }

  private async *retryStream(
    session: ProviderSession,
    opts?: TurnOptions & { sanitizeReasoning?: boolean },
  ): AsyncIterable<AgentEvent> {
    const inner = await this.inner();
    if (inner.retryTurn) {
      yield* inner.retryTurn(session, opts);
      return;
    }
    yield {
      type: "error",
      content: "Nothing to retry — send the message again.",
    };
    yield { type: "done" };
  }

  async dispose(session: ProviderSession): Promise<void> {
    if (this.innerResolved) await this.innerResolved.dispose(session);
  }

  /** Resource closer for registry eviction (built inner may hold MCP clients). */
  async close(closeInner: (inner: CodingAgentProvider) => Promise<void>) {
    if (this.innerResolved) await closeInner(this.innerResolved);
  }
}
