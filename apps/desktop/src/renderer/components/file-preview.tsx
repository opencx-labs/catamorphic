import type { ResourcePreview } from "@catamorphic/react";
import { createContext, useContext, useEffect, useState } from "react";
import { desktopApi } from "../lib/desktop-api";
import { ResourcePreviewContent } from "./catamorphic/resource-preview";

export const FilePreviewProjectContext = createContext<string | undefined>(
  undefined,
);

/** Mounted only while an inspector is open. No bytes or URLs enter chat metadata. */
export function FilePreview({
  filePath = "",
  document,
}: {
  filePath?: string;
  document?: { name: string; mediaType: string; dataBase64: string };
}) {
  const projectId = useContext(FilePreviewProjectContext);
  const [result, setResult] = useState<{
    path: string;
    document: typeof document;
    preview: ResourcePreview;
  }>();
  const [retry, setRetry] = useState(0);
  const key = `${projectId ?? ""}:${filePath}:${retry}`;
  useEffect(() => {
    let current = true;
    void desktopApi
      .filePreview(document ? { document } : { filePath, projectId })
      .then((preview) => {
        if (current) setResult({ path: key, document, preview });
      })
      .catch(() => {
        if (current)
          setResult({
            path: key,
            document,
            preview: {
              name:
                document?.name || filePath.split(/[\\/]/).at(-1) || filePath,
              location: filePath,
              typeLabel: "File",
              content: {
                kind: "unavailable",
                message:
                  "This file is missing or cannot be read on this machine.",
              },
            },
          });
      });
    return () => {
      current = false;
    };
  }, [filePath, projectId, key, document]);
  const preview =
    result?.path === key && result.document === document
      ? result.preview
      : undefined;
  return (
    <>
      {preview ? (
        <ResourcePreviewContent preview={preview} />
      ) : (
        <p role="status" className="py-3 text-xs text-fg-muted">
          Loading preview…
        </p>
      )}
      {preview?.content.kind === "unavailable" && (
        <button
          type="button"
          className="mt-2 text-xs text-accent hover:underline"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry preview
        </button>
      )}
    </>
  );
}
