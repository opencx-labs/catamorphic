import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { ResourceInspector } from "./resource-inspector.js";

export function AuthorizationInspector() {
  const attempt = useQuery({
    queryKey: ["desktop", "authorization"],
    queryFn: () => desktopApi.authorizationStatus(),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const { refetch } = attempt;
  useEffect(() => {
    const unsubscribe = desktopApi.onAuthorizationChanged(() => void refetch());
    // The attempt may start before this browser toolbar mounts.
    void refetch();
    return unsubscribe;
  }, [refetch]);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState(false);
  const expiresAt = attempt.data?.expiresAt;
  useEffect(() => {
    setOpened(false);
    setError(null);
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!attempt.data) return null;
  const seconds = Math.max(0, Math.ceil((attempt.data.expiresAt - now) / 1000));
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      await attempt.refetch();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(
              /^Error invoking remote method '[^']+': (?:Error: )?/,
              "",
            )
          : String(cause),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <ResourceInspector
      label="Sign-in help"
      pinOnClick
      content={
        <div className="w-80 space-y-3 p-3 text-xs">
          <div>
            <p className="font-medium text-fg">{attempt.data.label}</p>
            <p className="mt-1 text-fg-muted">
              Finish signing in to continue. This attempt expires in{" "}
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
              .
            </p>
          </div>
          <details>
            <summary className="cursor-pointer text-fg">
              Having trouble with a passkey?
            </summary>
            <div className="mt-2 space-y-3 text-fg-muted">
              <p>
                Browser import brings in passwords, but does not transfer
                passkeys. Try another method on the sign-in page.
              </p>
              <p>
                If you still cannot sign in, continue in your usual browser.
                Catamorphic will keep this attempt active.
              </p>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await desktopApi.authorizationContinueBrowser();
                    setOpened(true);
                  })
                }
                className="rounded-md bg-bg-overlay px-3 py-2 text-fg disabled:opacity-50"
              >
                Continue in your browser
              </button>
              {opened && (
                <p role="status">
                  Your browser is open. Return here after signing in.
                </p>
              )}
            </div>
          </details>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(() => desktopApi.authorizationCancel())}
            className="text-fg-muted hover:text-fg disabled:opacity-50"
          >
            Cancel sign-in
          </button>
        </div>
      }
    >
      {(props) => (
        <button
          {...props}
          type="button"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-fg-muted hover:bg-bg-overlay hover:text-fg"
        >
          <KeyRound className="size-3.5" />
          Sign-in help
        </button>
      )}
    </ResourceInspector>
  );
}
