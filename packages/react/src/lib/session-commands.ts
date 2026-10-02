import type {
  CommandReceipt,
  SessionCommand,
} from "@catamorphic/agent-protocol";
import type { CatamorphicApiClient } from "@catamorphic/api-client";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "./errors.js";
import { randomId } from "./random-id.js";

/** A command as a client composes it; the id is added when it is sent. */
export type SessionCommandInput = SessionCommand extends infer Command
  ? Command extends SessionCommand
    ? Omit<Command, "commandId">
    : never
  : never;

/**
 * Send one command to a session (ADR 0196) and return its receipt. The
 * `commandId` is generated once (or passed by a caller resending it): a
 * timeout or a server error resends the same id, which the server answers
 * with the first receipt instead of running the command twice. A refused
 * command throws a {@link CatamorphicError} with the refusal's message;
 * its code is in `details.code`.
 */
export async function sendSessionCommand({
  apiClient,
  projectId,
  sessionId,
  command,
  commandId = randomId(),
  attempts = 3,
}: {
  apiClient: CatamorphicApiClient;
  projectId: string;
  sessionId: string;
  command: SessionCommandInput;
  commandId?: string;
  attempts?: number;
}): Promise<CommandReceipt> {
  const body: SessionCommand = { ...command, commandId };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const receipt = await runWithCatamorphicError(async () =>
        assertApiOk(
          await apiClient.POST(
            "/api/projects/{projectId}/agent/sessions/{sessionId}/commands",
            {
              signal: AbortSignal.timeout(20_000),
              params: { path: { projectId, sessionId } },
              body,
            },
          ),
          "The command was not confirmed",
        ),
      );
      if (receipt.status === "rejected")
        throw new CatamorphicError({
          code: "conflict",
          message: receipt.error?.message ?? "The command was refused",
          status: 200,
          details: receipt,
        });
      return receipt;
    } catch (error) {
      const retryable =
        error instanceof CatamorphicError &&
        error.status !== 200 &&
        (error.code === "network" ||
          (error.status !== undefined && error.status >= 500));
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
}
