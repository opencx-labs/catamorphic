import type { ProjectSummary } from "@catamorphic/react/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

export function DeleteProjectModal({
  project,
  onClose,
  onDeleted,
}: {
  project: ProjectSummary | null;
  onClose: () => void;
  onDeleted: (projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [alsoTrash, setAlsoTrash] = useState(false);
  const [remoteMember, setRemoteMember] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = project?.id;
  useEffect(() => {
    let cancelled = false;
    setAlsoTrash(false);
    setError(null);
    setRootPath(null);
    setRemoteMember(null);
    if (projectId) {
      void desktopApi.projectRoot(projectId).then((root) => {
        if (!cancelled) setRootPath(root);
      });
      void desktopApi
        .remoteStatus(projectId)
        .then((status) => {
          if (cancelled) return;
          const member =
            status !== null && status.capabilities?.builder !== true;
          setRemoteMember(member);
          if (member) setAlsoTrash(true);
        })
        .catch(() => {
          if (!cancelled) setRemoteMember(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const confirm = async () => {
    if (!project || remoteMember === null) return;
    setPending(true);
    setError(null);
    try {
      await desktopApi.deleteProject({
        projectId: project.id,
        trashFolder: alsoTrash,
      });
      await queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
      onDeleted(project.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={project !== null} onClose={onClose} width={440}>
      <div className="px-5 pt-5">
        <h2 className="text-sm font-semibold text-fg">
          {remoteMember === false ? "Delete" : "Remove"}{" "}
          {project?.name ?? "project"}?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
          {remoteMember !== false
            ? "This removes the local copy from Work and moves its folder to the Trash. The shared project and its server history stay available to the team."
            : `The project is removed from Work. Its chats, workflows, and run history are deleted.${rootPath ? " The folder on disk is kept unless you say otherwise." : ""}`}
        </p>

        {rootPath && remoteMember === false && (
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-bg-inset p-3">
            <input
              type="checkbox"
              checked={alsoTrash}
              onChange={(event) => setAlsoTrash(event.target.checked)}
              data-testid="delete-trash-checkbox"
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-danger)]"
            />
            <span className="min-w-0 text-xs leading-relaxed text-fg-muted">
              Also move the project folder to the Trash
              <span
                className="mt-0.5 block truncate font-mono text-fg-faint"
                dir="rtl"
              >
                {rootPath}
              </span>
            </span>
          </label>
        )}

        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      </div>

      <footer className="mt-4 flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" onClick={onClose} className="button-ghost">
          Cancel
        </button>
        <PendingButton
          type="button"
          onClick={confirm}
          pending={pending}
          disabled={remoteMember === null}
          data-disabled-reason="Checking project membership"
          pendingLabel={remoteMember ? "Removing…" : "Deleting…"}
          data-testid="delete-confirm"
          className="button-danger"
        >
          {remoteMember !== false
            ? "Remove from this device"
            : alsoTrash
              ? "Delete and trash folder"
              : "Delete project"}
        </PendingButton>
      </footer>
    </Modal>
  );
}
