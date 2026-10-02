import { randomUUID } from "node:crypto";
import type {
  AttemptControl,
  AttemptHost,
  AttemptStart,
  HarnessAdapter,
  HarnessCapabilities,
} from "@catamorphic/agent-protocol/runner";
import { EchoAdapter } from "@catamorphic/agent-runner";

/**
 * A harness for tests that look at what Work hands a harness (ADR 0197):
 * every attempt's start is recorded, then the echo harness answers it, so
 * directives (`[[ask ...]]`, `[[wait ...]]`) still work.
 */
export class RecordingAdapter implements HarnessAdapter {
  readonly id: string;
  readonly attempts: AttemptStart[] = [];
  private readonly echo = new EchoAdapter();

  constructor(
    private readonly options: {
      id?: string;
      /** Run instead of the echo harness, e.g. to write files first. */
      before?: (attempt: AttemptStart, host: AttemptHost) => Promise<void>;
    } = {},
  ) {
    this.id = options.id ?? "echo";
  }

  capabilities(): HarnessCapabilities {
    return this.echo.capabilities();
  }

  start(attempt: AttemptStart, host: AttemptHost, local?: Record<string, unknown>): AttemptControl {
    this.attempts.push(attempt);
    if (!this.options.before) return this.echo.start(attempt, host);
    let control: AttemptControl | undefined;
    const ready = this.options.before(attempt, host).then(() => {
      control = this.echo.start(attempt, host);
      return control.finished;
    });
    void local;
    return {
      steer: async (input) => (control ? control.steer(input) : false),
      interrupt: () => control?.interrupt(),
      finished: ready.catch((error: unknown) => {
        host.emit({
          type: "turn.completed",
          status: "failed",
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }),
    };
  }

  /** The text of the last attempt's input. */
  lastInput(): string | undefined {
    return this.attempts.at(-1)?.input?.text;
  }
}

/** A unique id for test fixtures. */
export const fixtureId = () => randomUUID();
