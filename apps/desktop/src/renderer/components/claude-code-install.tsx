import { useEffect, useState } from "react";
import type { ClaudeCodeInstallStatus } from "../../shared/claude-code-install.js";
import { desktopApi } from "../lib/desktop-api";
import { PendingButton } from "./pending-button.js";

/**
 * Which Claude Code this agent runs (ADR 0196): the person's own install
 * when it is new enough, else Work's copy, with an Update action that runs
 * their install's own updater.
 */
export function ClaudeCodeInstall() {
  const [status, setStatus] = useState<ClaudeCodeInstallStatus | null>();
  const [updating, setUpdating] = useState(false);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void desktopApi
      .claudeCodeStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!status) return null;

  const update = async () => {
    setUpdating(true);
    setFailure(undefined);
    try {
      const result = await desktopApi.claudeCodeUpdate();
      setStatus(result.status);
      if (result.status.using !== "installed") {
        const lastLine = result.output.trim().split("\n").at(-1);
        setFailure(
          lastLine
            ? `Claude Code did not update: ${lastLine}`
            : "Claude Code did not update.",
        );
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  const { installed } = status;
  return (
    <div
      className="flex flex-col gap-1 text-xs text-fg-muted"
      data-testid="claude-code-install"
    >
      Claude Code
      <p className="text-fg-faint">
        {status.using === "installed" && installed
          ? `Runs your Claude Code ${installed.version}.`
          : installed
            ? `Runs Work's Claude Code ${status.minVersion}. Your Claude Code ${installed.version} is older than the ${status.minVersion} Work needs; update it to use your own.`
            : `Runs Work's Claude Code ${status.minVersion}. Install Claude Code to use your own.`}
      </p>
      {status.using === "work" && installed && (
        <PendingButton
          type="button"
          pending={updating}
          pendingLabel="Updating…"
          onClick={() => void update()}
          className="button-secondary button-sm mt-1 self-start"
          data-testid="claude-code-update"
        >
          Update Claude Code
        </PendingButton>
      )}
      {failure && (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      )}
    </div>
  );
}
