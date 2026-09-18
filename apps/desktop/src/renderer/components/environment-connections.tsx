import {
  type AuthorizationChallenge,
  useAuthorizeConnection,
  useCompleteConnectionAuthorization,
  useEnvironmentConnections,
} from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Modal } from "./modal.js";

export function EnvironmentConnections({
  projectId,
  environment,
  onOpenLink,
}: {
  projectId: string;
  environment: string;
  onOpenLink: (url: string) => void;
}) {
  const query = useEnvironmentConnections(projectId, environment);
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
        <Loader2 className="size-4 animate-spin" /> Loading connections
      </div>
    );
  }
  if (query.error) {
    return <p className="p-4 text-sm text-danger">{query.error.message}</p>;
  }
  if (!query.data?.length) {
    return (
      <p className="p-4 text-sm text-fg-muted">
        This Environment has no connection bindings.
      </p>
    );
  }
  return (
    <div className="space-y-2 p-3">
      {query.data.map((binding) => (
        <EnvironmentConnectionRow
          key={binding.id}
          projectId={projectId}
          environment={environment}
          binding={binding}
          onOpenLink={onOpenLink}
        />
      ))}
    </div>
  );
}

function EnvironmentConnectionRow({
  projectId,
  environment,
  binding,
  onOpenLink,
}: {
  projectId: string;
  environment: string;
  binding: NonNullable<
    ReturnType<typeof useEnvironmentConnections>["data"]
  >[number];
  onOpenLink: (url: string) => void;
}) {
  const queryClient = useQueryClient();
  const authorize = useAuthorizeConnection({
    projectId,
    environment,
    alias: binding.alias,
  });
  const complete = useCompleteConnectionAuthorization();
  const [authorization, setAuthorization] = useState<{
    authorizationId: string;
    challenge: AuthorizationChallenge;
  } | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: [
        "cat",
        "project",
        projectId,
        "environment",
        environment,
        "connections",
      ],
    });
  };
  const start = async () => {
    const result = await authorize.mutateAsync({});
    setAuthorization(result);
    if (result.challenge.kind === "url") onOpenLink(result.challenge.url);
    if (result.challenge.kind === "device") {
      onOpenLink(result.challenge.verificationUrl);
    }
  };
  const finish = async (callback: Record<string, string>) => {
    if (!authorization) return;
    await complete.mutateAsync({
      authorizationId: authorization.authorizationId,
      callback,
    });
    setFormValues({});
    setAuthorization(null);
    await refresh();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void finish(formValues);
  };
  const challenge = authorization?.challenge;
  // The dialog keeps its fields through the exit animation.
  const formChallenge = useRef<Extract<
    AuthorizationChallenge,
    { kind: "form" }
  > | null>(null);
  if (challenge?.kind === "form") formChallenge.current = challenge;
  const personal = binding.memberConnection;
  const service = binding.serviceConnection;
  return (
    <section className="rounded-lg border border-border bg-bg-surface p-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-fg">{binding.alias}</p>
          <p className="mt-0.5 text-fg-muted">{binding.providerKind}</p>
        </div>
        {binding.principalKinds.includes("member") && (
          <button
            type="button"
            disabled={authorize.isPending}
            data-disabled-reason="Connecting this account"
            onClick={() => void start()}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 font-medium hover:bg-bg-overlay disabled:cursor-wait disabled:opacity-60"
          >
            <KeyRound className="size-3.5" />
            {personal ? "Reauthenticate" : "Authenticate"}
          </button>
        )}
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <PrincipalLine label="Personal" principal={personal} />
        <PrincipalLine label="Service" principal={service} />
      </div>
      {challenge?.kind === "url" && (
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-md bg-accent-subtle px-2 py-1.5 font-medium text-accent"
        >
          <RefreshCw className="size-3.5" /> Refresh after sign-in
        </button>
      )}
      {challenge?.kind === "device" && (
        <div className="mt-2 rounded-md bg-bg-inset p-2">
          Enter code <code>{challenge.userCode}</code>, then{" "}
          <button type="button" onClick={() => void finish({})}>
            continue
          </button>
          .
        </div>
      )}
      <Modal
        open={challenge?.kind === "form"}
        onClose={() => setAuthorization(null)}
        width={420}
      >
        <form onSubmit={submit}>
          <div className="px-5 pt-5">
            <h2 className="text-sm font-semibold text-fg">
              Connect {binding.alias}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              {binding.providerKind} asks for these details.
            </p>
            <div className="mt-4 space-y-3 text-xs">
              {formChallenge.current?.fields.map((field) => (
                <label key={field.name} className="block">
                  <span className="mb-1 block text-fg-muted">
                    {field.label}
                  </span>
                  <input
                    type={field.secret ? "password" : "text"}
                    required={field.required}
                    value={formValues[field.name] ?? ""}
                    onChange={(event) =>
                      setFormValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    className="field h-8 w-full rounded-md px-2.5 text-[13px]"
                  />
                </label>
              ))}
            </div>
          </div>
          <footer className="mt-5 flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <button
              type="button"
              onClick={() => setAuthorization(null)}
              className="button-ghost"
            >
              Cancel
            </button>
            <button type="submit" className="button-primary">
              Save
            </button>
          </footer>
        </form>
      </Modal>
      {(authorize.error || complete.error) && (
        <p className="mt-2 text-danger">
          {(authorize.error ?? complete.error)?.message}
        </p>
      )}
    </section>
  );
}

function PrincipalLine({
  label,
  principal,
}: {
  label: string;
  principal: NonNullable<
    NonNullable<
      ReturnType<typeof useEnvironmentConnections>["data"]
    >[number]["memberConnection"]
  > | null;
}) {
  return (
    <div className="rounded-md bg-bg-inset px-2 py-1.5">
      <span className="text-fg-muted">{label}: </span>
      <span className="text-fg">{principal?.label ?? "Not configured"}</span>
      {principal && (
        <span className="ml-1 text-fg-muted">({principal.status})</span>
      )}
    </div>
  );
}
