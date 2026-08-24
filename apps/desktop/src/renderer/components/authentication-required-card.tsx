import {
  type AgentAuthenticationRequired,
  type AuthorizationChallenge,
  useAuthorizeConnection,
  useCompleteConnectionAuthorization,
} from "@catamorphic/react";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PendingButton } from "./pending-button.js";

type Requirement = AgentAuthenticationRequired["requirements"][number];

export function AuthenticationRequiredCard({
  projectId,
  environment,
  requirement,
  onOpenLink,
  onAuthorized,
}: {
  projectId: string;
  environment: string;
  requirement: Requirement;
  onOpenLink?: (url: string) => void;
  onAuthorized: () => void;
}) {
  const authorize = useAuthorizeConnection({
    projectId,
    environment,
    alias: requirement.alias,
  });
  const complete = useCompleteConnectionAuthorization();
  const [started, setStarted] = useState<{
    authorizationId: string;
    challenge: AuthorizationChallenge;
  } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const open = (url: string) => {
    if (onOpenLink) onOpenLink(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const start = async () => {
    const result = await authorize.mutateAsync({});
    setStarted(result);
    if (result.challenge.kind === "url") open(result.challenge.url);
    if (result.challenge.kind === "device") {
      open(result.challenge.verificationUrl);
    }
  };

  const finish = async (callback: Record<string, string>) => {
    if (!started) return;
    await complete.mutateAsync({
      authorizationId: started.authorizationId,
      callback,
    });
    setValues({});
    setStarted(null);
    onAuthorized();
  };

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    void finish(values);
  };

  const challenge = started?.challenge;
  const error = authorize.error ?? complete.error;
  const acceptsMember = requirement.principalKinds.includes("member");
  return (
    <div
      data-testid={`authentication-required-${requirement.alias}`}
      className="mx-3 mb-1 shrink-0 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-fg"
    >
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Connect {requirement.alias} to continue</p>
          <p className="mt-0.5 text-fg-muted">
            {acceptsMember
              ? `This session will run in ${environment} using your member access. The message stays queued until authentication succeeds.`
              : `This session requires a service connection in ${environment}. Ask a project administrator to configure it. The message stays queued.`}
          </p>

          {acceptsMember && !challenge && (
            <PendingButton
              type="button"
              pending={authorize.isPending}
              onClick={() => void start()}
              className="mt-2 cursor-pointer rounded-md bg-warning/20 px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-warning/30"
            >
              Authenticate
            </PendingButton>
          )}

          {challenge?.kind === "url" && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => open(challenge.url)}
                className="cursor-pointer rounded-md bg-warning/20 px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-warning/30"
              >
                Open sign-in
              </button>
              <button
                type="button"
                onClick={onAuthorized}
                className="cursor-pointer rounded-md border border-border px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-bg-overlay"
              >
                Continue
              </button>
            </div>
          )}

          {challenge?.kind === "device" && (
            <div className="mt-2 space-y-2">
              <p>
                Enter code{" "}
                <code className="rounded bg-bg-inset px-1.5 py-0.5 font-mono">
                  {challenge.userCode}
                </code>{" "}
                in the sign-in page.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => open(challenge.verificationUrl)}
                  className="cursor-pointer rounded-md bg-warning/20 px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-warning/30"
                >
                  Open sign-in
                </button>
                <PendingButton
                  type="button"
                  pending={complete.isPending}
                  onClick={() => void finish({})}
                  className="cursor-pointer rounded-md border border-border px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-bg-overlay"
                >
                  Continue
                </PendingButton>
              </div>
            </div>
          )}

          {challenge?.kind === "form" && (
            <form onSubmit={submitForm} className="mt-2 space-y-2">
              {challenge.fields.map((field) => (
                <label key={field.name} className="block">
                  <span className="mb-1 block text-fg-muted">
                    {field.label}
                  </span>
                  <input
                    name={field.name}
                    type={field.secret ? "password" : "text"}
                    required={field.required}
                    value={values[field.name] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    className="h-8 w-full rounded-md border border-border bg-bg-inset px-2 outline-none transition-colors duration-150 focus:border-border-strong"
                  />
                </label>
              ))}
              <PendingButton
                type="submit"
                pending={complete.isPending}
                className="cursor-pointer rounded-md bg-warning/20 px-2.5 py-1.5 font-medium transition-colors duration-150 hover:bg-warning/30"
              >
                Save and continue
              </PendingButton>
            </form>
          )}

          {error && <p className="mt-2 text-danger">{error.message}</p>}
        </div>
      </div>
    </div>
  );
}
