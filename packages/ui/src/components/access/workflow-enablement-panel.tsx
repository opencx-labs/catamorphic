import {
  type AgentAuthenticationRequired,
  authenticationRequiredFrom,
  useCreateWorkflowEnablement,
  useDeployProject,
  useEnvironments,
  usePreviewWorkflowEnablement,
  useRotateWebhook,
  useUpdateWorkflowEnablement,
  useWebhooks,
  useWorkflowEnablements,
  type Webhook,
  type WorkflowEnablement,
  type WorkflowEnablementInput,
  type WorkflowEnablementPreview,
} from "@catamorphic/react";
import {
  Box,
  Check,
  CircleAlert,
  Copy,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AuthenticationRequiredCard } from "./authentication-required-card.js";
import { PendingButton } from "./pending-button.js";

type Requirement = AgentAuthenticationRequired["requirements"][number];
type Audience = "member" | "project";

/** The preview refused because the workflow is only saved, not published. */
function notPublished(error: unknown): boolean {
  if (!(error instanceof Error) || !("details" in error)) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === "not_published"
  );
}

/** A trigger as a person reads it: "Webhook github", "Schedule 0 9 * * *". */
function describeTrigger(trigger: { kind: string; config: unknown }): string {
  const config: Record<string, unknown> =
    trigger.config && typeof trigger.config === "object"
      ? { ...trigger.config }
      : {};
  if (trigger.kind === "webhook")
    return `Webhook ${String(config.name ?? "")}${config.verify ? " (signed)" : ""}`;
  if (trigger.kind === "schedule")
    return typeof config.cron === "string"
      ? `Schedule ${config.cron}${typeof config.timezone === "string" ? ` (${config.timezone})` : ""}`
      : `Once at ${String(config.at ?? "")}`;
  const detail = Object.entries(config)
    .filter(
      ([, value]) => typeof value === "string" || typeof value === "number",
    )
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(", ");
  return detail ? `${trigger.kind} (${detail})` : trigger.kind;
}

export function WorkflowEnablementPanel({
  projectId,
  workflowName,
  onClose,
  inline = false,
}: {
  projectId: string;
  workflowName: string;
  onClose: () => void;
  inline?: boolean;
}) {
  const environments = useEnvironments(projectId, { workload: "workflow" });
  const enablements = useWorkflowEnablements(projectId, workflowName);
  const preview = usePreviewWorkflowEnablement(projectId);
  const create = useCreateWorkflowEnablement(projectId);
  const update = useUpdateWorkflowEnablement(projectId);
  const publish = useDeployProject(projectId);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  /** Why enabling waits on publishing, when it does. */
  const [unpublished, setUnpublished] = useState<string | null>(null);
  const canManageProjectAutomations =
    enablements.data?.canManageProjectAutomations ?? false;
  const webhooks = useWebhooks(projectId, {
    enabled: canManageProjectAutomations,
  });
  const workflowWebhooks =
    webhooks.data?.filter((item) => item.workflows.includes(workflowName)) ??
    [];
  const [audience, setAudience] = useState<Audience>("member");
  const [environment, setEnvironment] = useState("");
  const [review, setReview] = useState<WorkflowEnablementPreview | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [pendingInput, setPendingInput] =
    useState<WorkflowEnablementInput | null>(null);

  useEffect(() => {
    if (environment || !environments.data) return;
    const first =
      environments.data.items.find(
        (item) => item.name === environments.data?.defaultEnvironment,
      ) ?? environments.data.items.find((item) => item.compatible);
    if (first) setEnvironment(first.name);
  }, [environment, environments.data]);

  const applyConsent = async (next: WorkflowEnablementPreview) => {
    if (updatingId) {
      await update.mutateAsync({
        enablementId: updatingId,
        action: "update-deployment",
        consentDigest: next.consentDigest,
      });
    } else {
      await create.mutateAsync({
        workflowName,
        environment: next.environment,
        owner: next.owner,
        connectionSelections: Object.fromEntries(
          next.connections.map((connection) => [
            connection.alias,
            connection.connectionId,
          ]),
        ),
        consentDigest: next.consentDigest,
      });
    }
    setReview(null);
    setUpdatingId(null);
    setPendingInput(null);
  };

  const prepare = async (input: WorkflowEnablementInput) => {
    setReview(null);
    setRequirements([]);
    setPublishNote(null);
    setUnpublished(null);
    setPendingInput(input);
    try {
      const next = await preview.mutateAsync(input);
      setReview(next);
    } catch (error) {
      setRequirements(authenticationRequiredFrom(error)?.requirements ?? []);
      setUnpublished(
        notPublished(error) && error instanceof Error ? error.message : null,
      );
    }
  };

  const confirm = async () => {
    if (!review) return;
    await applyConsent(review);
  };

  const prepareDeploymentUpdate = async (item: WorkflowEnablement) => {
    setRequirements([]);
    setUpdatingId(item.id);
    setAudience(item.owner.type);
    await prepare({
      workflowName,
      environment: item.environment,
      owner: item.owner,
      connectionSelections: Object.fromEntries(
        item.connections.map((connection) => [
          connection.alias,
          connection.connectionId,
        ]),
      ),
    });
    setEnvironment(item.environment);
  };

  const items = enablements.data?.items ?? [];
  const environmentLabel = (name: string) =>
    environments.data?.items.find((item) => item.name === name)?.label ?? name;
  const reviewingProject = review?.owner.type === "project";
  const resetReview = () => {
    setReview(null);
    setRequirements([]);
    setPendingInput(null);
    setUpdatingId(null);
  };

  const needsPublish = unpublished !== null;
  const publishAndContinue = async () => {
    if (!pendingInput) return;
    const result = await publish.mutateAsync(undefined).catch(() => null);
    if (result?.status === "conflict") {
      setPublishNote(
        "The project has changes from elsewhere that conflict with yours. Resolve them in Changes, then try again.",
      );
      return;
    }
    if (result) await prepare(pendingInput);
  };

  const mutationError =
    publish.error ??
    preview.error ??
    create.error ??
    update.error ??
    environments.error ??
    enablements.error;
  const busy =
    preview.isPending ||
    create.isPending ||
    update.isPending ||
    publish.isPending;
  return (
    <aside
      aria-label="Workflow enablement"
      className={
        inline
          ? "flex min-h-0 flex-1 flex-col"
          : "absolute inset-y-0 right-0 z-30 flex w-[380px] max-w-full flex-col border-l border-border bg-bg shadow-xl"
      }
      data-testid="workflow-enablement-panel"
    >
      {/* Inline, the host panel owns the title and close action. */}
      {!inline && (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-accent" />
            Run automatically
          </div>
          <button
            type="button"
            aria-label="Close workflow enablement"
            onClick={onClose}
            className="cursor-pointer rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div
        className={`min-h-0 flex-1 overflow-y-auto text-xs ${inline ? "px-5 py-4" : "p-3"}`}
      >
        <p className="text-fg-muted">
          {canManageProjectAutomations
            ? "Choose who this workflow runs for. It uses only the environment and connections shown here."
            : "Enable this reviewed workflow for your account. It uses only the environment and connections shown here."}
        </p>

        {canManageProjectAutomations && (
          <fieldset className="mt-4">
            <legend className="mb-1 block font-medium">Runs for</legend>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-inset p-0.5">
              {(["member", "project"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={audience === option}
                  disabled={busy}
                  onClick={() => {
                    setAudience(option);
                    resetReview();
                  }}
                  className={`h-7 cursor-pointer rounded font-medium ${
                    audience === option
                      ? "bg-bg text-fg shadow-sm"
                      : "text-fg-muted hover:text-fg"
                  }`}
                >
                  {option === "member" ? "Just me" : "The project"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-fg-muted">
              {audience === "project"
                ? "Runs for the whole project, not as you. Chats it starts are shared with everyone in the project."
                : "Runs as you, with your connections. Chats it starts are yours."}
            </p>
          </fieldset>
        )}

        <label className="mt-4 block">
          <span className="mb-1 block font-medium">Environment</span>
          <select
            disabled={busy || environments.isLoading}
            value={environment}
            onChange={(event) => {
              setEnvironment(event.target.value);
              resetReview();
            }}
            className="h-8 w-full rounded-md border border-border bg-bg-inset px-2 outline-none focus:border-accent"
          >
            {environments.data?.items
              .filter((item) => item.allowed)
              .map((item) => (
                <option
                  key={item.name}
                  value={item.name}
                  disabled={!item.compatible || !item.available}
                  data-disabled-reason="This connection is incompatible with the workflow"
                >
                  {item.label}
                  {item.reasons.length ? ` (${item.reasons.join("; ")})` : ""}
                </option>
              ))}
          </select>
        </label>
        {environments.isLoading && (
          <p role="status" className="mt-2 text-fg-muted">
            Loading environments…
          </p>
        )}
        {environments.isSuccess &&
          !environments.data.items.some(
            (item) => item.allowed && item.compatible && item.available,
          ) && (
            <p className="mt-2 text-fg-muted">
              No permitted environment is available. Ask a project manager to
              configure one.
            </p>
          )}
        {enablements.isLoading && (
          <p role="status" className="mt-2 text-fg-muted">
            Loading automation settings…
          </p>
        )}

        {!review &&
          requirements.length === 0 &&
          !needsPublish &&
          !items.some(
            (item) =>
              item.environment === environment && item.owner.type === audience,
          ) && (
            <PendingButton
              type="button"
              pending={preview.isPending}
              pendingLabel="Checking…"
              disabled={!environment}
              data-disabled-reason="Choose an environment first"
              onClick={() => {
                setUpdatingId(null);
                void prepare({
                  workflowName,
                  ...(environment ? { environment } : {}),
                  ...(audience === "project"
                    ? { owner: { type: "project" } }
                    : {}),
                });
              }}
              className="mt-3 h-8 cursor-pointer rounded-md bg-accent px-3 font-medium text-accent-fg disabled:opacity-50"
            >
              {audience === "project"
                ? "Enable for the project"
                : "Enable for me"}
            </PendingButton>
          )}

        {requirements.map((requirement) => (
          <div key={requirement.alias} className="-mx-3 mt-3">
            <AuthenticationRequiredCard
              projectId={projectId}
              environment={environment}
              requirement={requirement}
              purpose="workflow"
              onAuthorized={() => pendingInput && void prepare(pendingInput)}
            />
          </div>
        ))}

        {review && (
          <section className="mt-4 rounded-md border border-border bg-bg-inset p-3">
            <div className="flex items-center gap-2 font-medium">
              <Check className="size-4 text-success" />
              Consent summary
            </div>
            <dl className="mt-3 grid grid-cols-[88px_1fr] gap-x-2 gap-y-1.5 text-fg-muted">
              <dt>Owner</dt>
              <dd className="text-fg">
                {reviewingProject ? "The project" : "You"}
              </dd>
              <dt>Environment</dt>
              <dd className="text-fg">
                {environmentLabel(review.environment)}
              </dd>
              <dt>Revision</dt>
              <dd className="truncate font-mono text-fg">
                {review.commitSha.slice(0, 12)}
              </dd>
              <dt>Connections</dt>
              <dd className="text-fg">
                {review.connections.length
                  ? review.connections
                      .map(
                        (item) =>
                          `${item.alias}: ${review.connectionLabels[item.connectionId] ?? item.providerKind} · ${item.principalKind === "member" ? "your account" : "shared"}`,
                      )
                      .join(", ")
                  : "None"}
              </dd>
              <dt>Actions</dt>
              <dd className="text-fg">
                {review.capabilities.length
                  ? review.capabilities.join(", ")
                  : "No external actions"}
              </dd>
              <dt>Triggers</dt>
              <dd className="text-fg">
                {review.triggers.length
                  ? review.triggers.map(describeTrigger).join("; ")
                  : "No automatic triggers configured"}
              </dd>
            </dl>
            <p className="mt-3 text-fg-muted">
              {reviewingProject
                ? "This workflow runs for the project whenever it is triggered, including when nobody is online. Anyone who manages the project can pause it. Changes to its deployment or access require review."
                : "This workflow may run when you are away. You can pause it at any time. Changes to its deployment or access require review. Access is checked before every run and connection action."}
            </p>
            <div className="mt-3 flex gap-2">
              <PendingButton
                type="button"
                pending={create.isPending || update.isPending}
                pendingLabel={updatingId ? "Updating…" : "Enabling…"}
                onClick={() => void confirm().catch(() => {})}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 font-medium text-accent-fg"
              >
                {updatingId ? "Confirm update" : "Confirm and enable"}
              </PendingButton>
              <button
                type="button"
                onClick={resetReview}
                className="cursor-pointer rounded-md border border-border px-3 font-medium hover:bg-bg-overlay"
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        {needsPublish && !publish.error ? (
          <section
            className="mt-4 rounded-md border border-border bg-bg-inset p-3"
            data-testid="workflow-not-published"
          >
            <p>{unpublished}</p>
            {publishNote && <p className="mt-2 text-warning">{publishNote}</p>}
            {canManageProjectAutomations ? (
              <PendingButton
                type="button"
                pending={publish.isPending || preview.isPending}
                pendingLabel="Publishing…"
                onClick={() => void publishAndContinue()}
                className="mt-3 h-8 cursor-pointer rounded-md bg-accent px-3 font-medium text-accent-fg"
              >
                Publish changes and continue
              </PendingButton>
            ) : (
              <p className="mt-2 text-fg-muted">
                Ask someone who manages the project to publish it.
              </p>
            )}
          </section>
        ) : (
          mutationError &&
          requirements.length === 0 && (
            <p role="alert" className="mt-3 flex gap-2 text-danger">
              <CircleAlert className="size-4 shrink-0" />
              {mutationError.message}
            </p>
          )
        )}

        {workflowWebhooks.map((webhook) => (
          <WebhookUrl
            key={webhook.name}
            projectId={projectId}
            webhook={webhook}
          />
        ))}

        <div className="mt-5 border-t border-border pt-4">
          <h3 className="font-medium">Enabled</h3>
          <div className="mt-2 space-y-2">
            {items.map((item) => {
              const forProject = item.owner.type === "project";
              const manageable = !forProject || canManageProjectAutomations;
              return (
                <div
                  key={item.id}
                  className="rounded-md border border-border p-2.5"
                  data-testid="workflow-enablement"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-medium">
                      {forProject && <Box className="size-3.5 text-fg-muted" />}
                      {forProject ? "For the project" : "For you"}
                      <span className="font-normal text-fg-muted">
                        ·{" "}
                        {item.status === "active"
                          ? "On"
                          : item.status === "suspended"
                            ? "Needs attention"
                            : "Paused"}
                      </span>
                    </span>
                    <span className="text-fg-muted">
                      {environmentLabel(item.environment)}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-fg-muted">
                    {item.commitSha.slice(0, 12)}
                    {item.updateAvailable ? " · update available" : ""}
                  </p>
                  {item.suspensionReason && (
                    <p className="mt-1 text-warning">{item.suspensionReason}</p>
                  )}
                  {manageable && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.status === "active" ? (
                        <PendingButton
                          type="button"
                          pending={update.isPending}
                          onClick={() =>
                            void update
                              .mutateAsync({
                                enablementId: item.id,
                                action: "disable",
                              })
                              .catch(() => {})
                          }
                          className="cursor-pointer rounded border border-border px-2 py-1 hover:bg-bg-overlay"
                        >
                          Pause
                        </PendingButton>
                      ) : (
                        <PendingButton
                          type="button"
                          pending={update.isPending}
                          onClick={() => void prepareDeploymentUpdate(item)}
                          className="cursor-pointer rounded border border-border px-2 py-1 hover:bg-bg-overlay"
                        >
                          Review and resume
                        </PendingButton>
                      )}
                      {item.updateAvailable && (
                        <PendingButton
                          type="button"
                          pending={preview.isPending || update.isPending}
                          onClick={() => void prepareDeploymentUpdate(item)}
                          className="cursor-pointer rounded border border-border px-2 py-1 hover:bg-bg-overlay"
                        >
                          Review update
                        </PendingButton>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {enablements.isSuccess && items.length === 0 && (
              <p className="text-fg-muted">Not enabled yet.</p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * A webhook's URL, for pasting into the sending service. The URL is the
 * sender's credential, so replacing it cuts off anyone holding the old one.
 */
function WebhookUrl({
  projectId,
  webhook,
}: {
  projectId: string;
  webhook: Webhook;
}) {
  const rotate = useRotateWebhook(projectId);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <section
      className="mt-4 rounded-md border border-border p-3"
      aria-label={`Webhook ${webhook.name}`}
      data-testid="workflow-webhook"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Webhook URL</span>
        <span className="text-fg-muted">
          {webhook.listening
            ? webhook.verified
              ? "Receiving · signed"
              : "Receiving"
            : "Enable to start receiving"}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1">
        <input
          readOnly
          value={webhook.url}
          aria-label={`${webhook.name} webhook URL`}
          onFocus={(event) => event.currentTarget.select()}
          className="h-7 min-w-0 flex-1 truncate rounded border border-border bg-bg-inset px-2 font-mono text-[11px] outline-none focus:border-accent"
        />
        <button
          type="button"
          aria-label="Copy webhook URL"
          title={copied ? "Copied" : "Copy"}
          onClick={() =>
            void navigator.clipboard
              .writeText(webhook.url)
              .then(() => setCopied(true))
              .catch(() => {})
          }
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded border border-border hover:bg-bg-overlay"
        >
          {copied ? (
            <Check className="size-3.5 text-success" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>
      <p className="mt-1.5 text-fg-muted">
        {onlyThisComputer(webhook.url)
          ? "This address only works on this computer. To receive requests from other services, enable the workflow on your project's server."
          : `Anyone with this URL can send requests${webhook.verified ? " signed with the project's secret" : ""}. Keep it private.`}
      </p>
      {confirmRotate ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-fg-muted">The current URL stops working.</span>
          <PendingButton
            type="button"
            pending={rotate.isPending}
            pendingLabel="Replacing…"
            onClick={() =>
              void rotate
                .mutateAsync({ name: webhook.name })
                .then(() => setConfirmRotate(false))
                .catch(() => {})
            }
            className="cursor-pointer rounded border border-border px-2 py-1 text-danger hover:bg-bg-overlay"
          >
            Replace URL
          </PendingButton>
          <button
            type="button"
            onClick={() => setConfirmRotate(false)}
            className="cursor-pointer rounded px-2 py-1 hover:bg-bg-overlay"
          >
            Keep it
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmRotate(true)}
          className="mt-2 flex cursor-pointer items-center gap-1 text-fg-muted hover:text-fg"
        >
          <RefreshCw className="size-3" />
          Replace URL
        </button>
      )}
      {rotate.error && (
        <p role="alert" className="mt-1 text-danger">
          {rotate.error.message}
        </p>
      )}
    </section>
  );
}

/** Loopback URLs reach this computer only; outside senders cannot use them. */
function onlyThisComputer(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}
