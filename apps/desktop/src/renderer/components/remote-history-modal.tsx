import { useEffect, useState } from "react";
import { desktopApi, type RemoteDocumentVersion } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";

/**
 * A store document's history (ADR 0055): every version the server keeps,
 * who wrote it and when; pick one to read it. Read-only — restoring is
 * copying the text back into the file and shipping.
 */
export function RemoteHistoryModal({
  projectId,
  path,
  onClose,
}: {
  projectId: string;
  path: string | null;
  onClose: () => void;
}) {
  const open = path !== null;
  const [versions, setVersions] = useState<RemoteDocumentVersion[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    setVersions([]);
    setSelected(null);
    setText(null);
    setError(null);
    desktopApi
      .remoteHistory({ projectId, path })
      .then((list) => {
        setVersions(list);
        const latest = list.find((v) => !v.deleted);
        if (latest) setSelected(latest.version);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [projectId, path]);

  useEffect(() => {
    if (!path || selected === null) return;
    setText(null);
    desktopApi
      .remoteReadVersion({ projectId, path, version: selected })
      .then((result) => setText(result.text ?? "(binary content)"))
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [projectId, path, selected]);

  const name = path?.split("/").at(-1) ?? "";
  return (
    <Modal open={open} onClose={onClose} width={720}>
      <div className="flex flex-col px-5 pt-5 pb-4">
        <h2 className="truncate text-[15px] font-semibold text-fg">
          History · {name}
        </h2>
        <p className="mt-0.5 truncate font-mono text-[11px] text-fg-faint">
          {path}
        </p>
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-4 grid grid-cols-[200px_1fr] gap-4">
          <ul className="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto">
            {versions.map((version) => (
              <li key={version.version}>
                <button
                  type="button"
                  onClick={() => setSelected(version.version)}
                  disabled={version.deleted}
                  className={`flex w-full cursor-pointer flex-col rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-bg-overlay disabled:cursor-default disabled:opacity-60 ${
                    selected === version.version ? "bg-bg-overlay" : ""
                  }`}
                >
                  <span className="text-xs text-fg">
                    v{version.version}
                    {version.deleted ? " · deleted" : ""}
                  </span>
                  <span className="truncate text-[11px] text-fg-faint">
                    {version.writtenBy} ·{" "}
                    {new Date(version.writtenAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
            {versions.length === 0 && !error && (
              <li className="px-2 py-1.5 text-xs text-fg-faint">Loading…</li>
            )}
          </ul>
          <pre className="max-h-[360px] overflow-auto rounded-md bg-bg-inset p-3 font-mono text-[12px] leading-relaxed text-fg whitespace-pre-wrap">
            {text ?? (selected !== null ? "Loading…" : "")}
          </pre>
        </div>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Close
        </button>
      </footer>
    </Modal>
  );
}
