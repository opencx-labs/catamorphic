import {
  AuthenticationRequiredError,
  EnvironmentAccessDeniedError,
  EnvironmentBindingUnavailableError,
  EnvironmentIncompatibleError,
  EnvironmentNotFoundError,
  NoCompatibleEnvironmentError,
  PluginSecretsMissingError,
  ProductionDeploymentNotFoundError,
  ProjectNotFoundError,
  RunCapabilityError,
  RunEnrollmentConflictError,
  RunInputInvalidError,
  SandboxProviderNotConfiguredError,
  TenantActiveRunLimitError,
  WorkflowNotFoundError,
} from "@catamorphic/core";
import type { FastifyReply } from "fastify";

/**
 * Maps the errors a run trigger (async start or sync call) can raise onto
 * HTTP statuses. Returns the reply when handled, `null` when the error is
 * not a trigger error and should propagate.
 */
export function replyForTriggerError(
  err: unknown,
  reply: FastifyReply,
): FastifyReply | null {
  if (err instanceof ProjectNotFoundError) {
    return reply.status(404).send({ error: "Project not found" });
  }
  if (err instanceof WorkflowNotFoundError) {
    return reply.status(404).send({ error: "Workflow not found" });
  }
  if (err instanceof ProductionDeploymentNotFoundError) {
    return reply.status(409).send({ error: err.message });
  }
  if (err instanceof RunEnrollmentConflictError) {
    return reply.status(409).send({ error: err.message });
  }
  if (err instanceof AuthenticationRequiredError) {
    return reply.status(428).send({
      error: err.message,
      code: "authentication_required",
      environment: err.environment,
      requirements: [...err.requirements],
    });
  }
  if (err instanceof EnvironmentAccessDeniedError) {
    return reply.status(403).send({ error: err.message });
  }
  if (err instanceof EnvironmentNotFoundError) {
    return reply.status(404).send({ error: err.message });
  }
  if (err instanceof EnvironmentBindingUnavailableError) {
    return reply.status(409).send({ error: err.message });
  }
  if (
    err instanceof EnvironmentIncompatibleError ||
    err instanceof NoCompatibleEnvironmentError
  ) {
    return reply.status(422).send({ error: err.message });
  }
  if (err instanceof TenantActiveRunLimitError) {
    return reply.status(429).send({ error: err.message });
  }
  if (err instanceof RunCapabilityError) {
    return reply.status(409).send({ error: err.message });
  }
  if (err instanceof PluginSecretsMissingError) {
    return reply.status(400).send({ error: err.message });
  }
  if (err instanceof RunInputInvalidError) {
    return reply.status(400).send({ error: err.message });
  }
  if (err instanceof SandboxProviderNotConfiguredError) {
    return reply.status(503).send({
      error:
        "Sandbox provider not configured. Set CLOUDFLARE_SANDBOX_API_URL and CLOUDFLARE_SANDBOX_API_KEY (recommended) or DAYTONA_API_KEY to enable workflow execution.",
    });
  }
  return null;
}
