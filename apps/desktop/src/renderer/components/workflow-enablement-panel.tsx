import {
  type AgentAuthenticationRequired,
  useCreateWorkflowEnablement,
  useEnvironments,
  usePreviewWorkflowEnablement,
  useUpdateWorkflowEnablement,
  useWorkflowEnablements,
  type WorkflowEnablement,
  type WorkflowEnablementInput,
  type WorkflowEnablementPreview,
} from "@catamorphic/react";
import { Check, CircleAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthenticationRequiredCard } from "./authentication-required-card.js";
import { PendingButton } from "./pending-button.js";

type Requirement = AgentAuthenticationRequired["requirements"][number];

export function WorkflowEnablementPanel({
  projectId,
  workflowName,
  onClose,
}: {
  projectId: string;
  workflowName: string;
  onClose: () => void;
}) {
  const environments = useEnvironments(projectId, { workload: "workflow" });
  const enablements = useWorkflowEnablements(projectId, workflowName);
  const preview = usePreviewWorkflowEnablement(projectId);
  const create = useCreateWorkflowEnablement(projectId);
  const update = useUpdateWorkflowEnablement(projectId);
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

  const prepare = async (
    input: WorkflowEnablementInput,
    enableAfterAuthentication = false,
  ) => {
    setReview(null);
    setRequirements([]);
    setPendingInput(input);
    try {
      const next = await preview.mutateAsync(input);
      if (enableAfterAuthentication) {
        await applyConsent(next);
      } else {
        setReview(next);
      }
    } catch (error) {
      const details =
        typeof error === "object" && error && "details" in error
          ? error.details
          : undefined;
      if (
        typeof details === "object" &&
        details &&
        "requirements" in details &&
        Array.isArray(details.requirements)
      ) {
        setRequirements(details.requirements as Requirement[]);
      }
    }
  };

  const confirm = async () => {
    if (!review) return;
    await applyConsent(review);
  };

  const prepareDeploymentUpdate = async (item: WorkflowEnablement) => {
    setRequirements([]);
    setUpdatingId(item.id);
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

  const mutationError = preview.error ?? create.error ?? update.error;
  return (
    <aside
      aria-label="Workflow enablement"
      className="absolute inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-border bg-bg shadow-xl"
      data-testid="workflow-enablement-panel"
    >
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

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        <p className="text-fg-muted">
          Enable this reviewed workflow for your account. It will use only the
          Environment and exact connections shown here.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block font-medium">Environment</span>
          <select
            value={environment}
            onChange={(event) => {
              setEnvironment(event.target.value);
              setReview(null);
              setRequirements([]);
            }}
            className="h-8 w-full rounded-md border border-border bg-bg-inset px-2 outline-none focus:border-accent"
          >
            {environments.data?.items
              .filter((item) => item.allowed)
              .map((item) => (
                <option
                  key={item.name}
                  value={item.name}
                  disabled={!item.compatible}
                >
                  {item.label}
                </option>
              ))}
          </select>
        </label>

        {!review &&
          requirements.length === 0 &&
          enablements.data?.length === 0 && (
            <PendingButton
              type="button"
              pending={preview.isPending}
              pendingLabel="Checking…"
              disabled={!environment}
              onClick={() => {
                setUpdatingId(null);
                void prepare({
                  workflowName,
                  ...(environment ? { environment } : {}),
                });
              }}
              className="mt-3 h-8 cursor-pointer rounded-md bg-accent px-3 font-medium text-accent-fg disabled:opacity-50"
            >
              Enable for me
            </PendingButton>
          )}

        {requirements.map((requirement) => (
          <div key={requirement.alias} className="-mx-3 mt-3">
            <AuthenticationRequiredCard
              projectId={projectId}
              environment={environment}
              requirement={requirement}
              onAuthorized={() =>
                pendingInput && void prepare(pendingInput, true)
              }
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
              <dd className="text-fg">You</dd>
              <dt>Environment</dt>
              <dd className="text-fg">{review.environment}</dd>
              <dt>Revision</dt>
              <dd className="truncate font-mono text-fg">
                {review.commitSha.slice(0, 12)}
              </dd>
              <dt>Connections</dt>
              <dd className="text-fg">
                {review.connections.length
                  ? review.connections.map((item) => item.alias).join(", ")
                  : "None"}
              </dd>
              <dt>Actions</dt>
              <dd className="text-fg">
                {review.capabilities.length
                  ? review.capabilities.join(", ")
                  : "No external actions"}
              </dd>
              <dt>Triggers</dt>
              <dd className="text-fg">{review.triggerCount}</dd>
            </dl>
            <p className="mt-3 text-fg-muted">
              Enabling stores this consent. Access is checked again before every
              run and connection action.
            </p>
            <div className="mt-3 flex gap-2">
              <PendingButton
                type="button"
                pending={create.isPending || update.isPending}
                pendingLabel={updatingId ? "Updating…" : "Enabling…"}
                onClick={() => void confirm()}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 font-medium text-accent-fg"
              >
                {updatingId ? "Confirm update" : "Confirm and enable"}
              </PendingButton>
              <button
                type="button"
                onClick={() => {
                  setReview(null);
                  setUpdatingId(null);
                }}
                className="cursor-pointer rounded-md border border-border px-3 font-medium hover:bg-bg-overlay"
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        {mutationError && requirements.length === 0 && (
          <p className="mt-3 flex gap-2 text-danger">
            <CircleAlert className="size-4 shrink-0" />
            {mutationError.message}
          </p>
        )}

        <div className="mt-5 border-t border-border pt-4">
          <h3 className="font-medium">Your enablement</h3>
          <div className="mt-2 space-y-2">
            {enablements.data?.map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-border p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{item.status}</span>
                  <span className="text-fg-muted">{item.environment}</span>
                </div>
                <p className="mt-1 font-mono text-[11px] text-fg-muted">
                  {item.commitSha.slice(0, 12)}
                  {item.updateAvailable ? " · update available" : ""}
                </p>
                {item.suspensionReason && (
                  <p className="mt-1 text-warning">{item.suspensionReason}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.status === "active" ? (
                    <PendingButton
                      type="button"
                      pending={update.isPending}
                      onClick={() =>
                        void update.mutateAsync({
                          enablementId: item.id,
                          action: "disable",
                        })
                      }
                      className="cursor-pointer rounded border border-border px-2 py-1 hover:bg-bg-overlay"
                    >
                      Disable
                    </PendingButton>
                  ) : (
                    <PendingButton
                      type="button"
                      pending={update.isPending}
                      onClick={() =>
                        void update.mutateAsync({
                          enablementId: item.id,
                          action: "reenable",
                        })
                      }
                      className="cursor-pointer rounded border border-border px-2 py-1 hover:bg-bg-overlay"
                    >
                      Check access
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
              </div>
            ))}
            {enablements.data?.length === 0 && (
              <p className="text-fg-muted">Not enabled for your account.</p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
