import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  NO_CAPABILITIES,
} from "@catamorphic/agent-protocol/runner";
import { friendlyTurnError } from "./agent-errors.js";

/** The adapter an attempt runs on, and the attempt as it should start. */
export interface PreparedAttempt {
  adapter: HarnessAdapter;
  attempt: AttemptStart;
}

/** Who failed, for errors rewritten into words the person can act on. */
export interface AgentErrorLabels {
  agentName: string;
  /** The harness or model provider: "Claude Code", "OpenRouter". */
  providerLabel: string;
}

/**
 * A desktop agent's harness (ADR 0197): an adapter whose attempt needs
 * readying first, on the host, before the harness starts. The integrity
 * pinned executable may still be downloading, or a project secret still
 * resolving, so `prepare` may take a while; the attempt is running
 * meanwhile and can be interrupted. Failed turns carry friendly errors.
 *
 * The id and capabilities are the inner adapter's, stated up front: the
 * runner reports them before the attempt starts.
 */
export function desktopAdapter({
  id,
  capabilities,
  prepare,
  errors,
}: {
  id: string;
  capabilities: () => HarnessCapabilities;
  prepare: (attempt: AttemptStart) => Promise<PreparedAttempt>;
  errors?: AgentErrorLabels;
}): HarnessAdapter {
  return {
    id,
    capabilities,
    start: (attempt, host, local) => {
      const friendly = errors ? friendlyHost({ host, errors }) : host;
      let inner: AttemptControl | undefined;
      let interrupted = false;
      const ready = prepare(attempt).then((prepared) => {
        if (interrupted) {
          friendly.emit({ type: "turn.completed", status: "interrupted" });
          return undefined;
        }
        inner = prepared.adapter.start(prepared.attempt, friendly, local);
        return inner;
      });
      const finished = ready
        .then((control) => control?.finished)
        .catch((error: unknown) => {
          friendly.emit({
            type: "turn.completed",
            status: "failed",
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return {
        steer: async (input) => {
          const control = await ready.catch(() => undefined);
          return control ? control.steer(input) : false;
        },
        interrupt: (reason) => {
          if (inner) inner.interrupt(reason);
          else interrupted = true;
        },
        finished,
      };
    },
  };
}

/** The host as the adapter sees it: failed turns say what to do next. */
function friendlyHost({
  host,
  errors,
}: {
  host: AttemptHost;
  errors: AgentErrorLabels;
}): AttemptHost {
  const emit = (event: HarnessEvent) =>
    host.emit(
      event.type === "turn.completed" && event.error
        ? {
            ...event,
            error: friendlyTurnError({ error: event.error, ...errors }),
          }
        : event,
    );
  return {
    emit,
    callTool: (input) => host.callTool(input),
    authorize: (input) => host.authorize(input),
    request: (key, request, options) => host.request(key, request, options),
    nativeState: host.nativeState,
    signal: host.signal,
  };
}

/**
 * An agent that cannot run (an unconsented, invalid or unsupported project
 * agent) but must never hang a turn: every attempt fails at once with the
 * message, which says how to fix it. Its id never matches a real harness,
 * so once the blocker clears the chat starts a thread on the real one.
 */
export function unavailableAdapter(message: string): HarnessAdapter {
  return {
    id: "unavailable",
    capabilities: () => NO_CAPABILITIES,
    start: () => {
      throw new Error(message);
    },
  };
}
