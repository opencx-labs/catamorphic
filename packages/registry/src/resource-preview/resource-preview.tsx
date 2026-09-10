"use client";

import type { ResourcePreview } from "@catamorphic/react";
import { useState } from "react";

export function formatPreviewBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Presentational preview. Hosts supply bounded content and own access/loading. */
export function ResourcePreviewContent({
  preview,
}: {
  preview: ResourcePreview;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const content = preview.content;
  const source = "src" in content ? content.src : undefined;
  // Never turn arbitrary document/HTML bytes into a browsing context.
  const safeSource =
    source &&
    /^(?:blob:|data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)|audio\/[\w.+-]+|video\/[\w.+-]+);base64,|https?:\/\/)/i.test(
      source,
    );
  const failed = source && (failedSource === source || !safeSource);
  return (
    <div className="min-w-0" data-resource-preview-kind={content.kind}>
      <div className="flex min-w-0 items-start justify-between gap-3 text-xs">
        <span className="min-w-0 break-words font-medium text-fg">
          {preview.name}
        </span>
        <span className="shrink-0 text-fg-muted">
          {preview.typeLabel}
          {preview.sizeBytes === undefined
            ? ""
            : ` · ${formatPreviewBytes(preview.sizeBytes)}`}
        </span>
      </div>
      {failed ? (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          This file could not be previewed.
        </p>
      ) : content.kind === "image" ? (
        <img
          src={content.src}
          alt={preview.name}
          onError={() => setFailedSource(content.src)}
          className="mt-2 max-h-64 w-full rounded-md bg-bg-inset object-contain"
          draggable={false}
        />
      ) : content.kind === "audio" ? (
        // biome-ignore lint/a11y/useMediaCaption: User-supplied attachments do not have authored caption tracks.
        <audio
          aria-label={`Preview ${preview.name}`}
          controls
          preload="metadata"
          src={content.src}
          onError={() => setFailedSource(content.src)}
          className="mt-2 w-full"
        >
          Audio preview unavailable.
        </audio>
      ) : content.kind === "video" ? (
        // biome-ignore lint/a11y/useMediaCaption: User-supplied attachments do not have authored caption tracks.
        <video
          aria-label={`Preview ${preview.name}`}
          controls
          playsInline
          preload="auto"
          src={content.src}
          onError={() => setFailedSource(content.src)}
          className="mt-2 max-h-64 w-full rounded-md bg-bg-inset"
        >
          Video preview unavailable.
        </video>
      ) : content.kind === "text" ? (
        <>
          <pre
            data-testid="pill-preview-text"
            className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted"
          >
            {content.text || "Empty file"}
          </pre>
          {content.truncated && (
            <p className="mt-1 text-[11px] text-fg-muted">
              Showing the beginning of this file.
            </p>
          )}
        </>
      ) : (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          {content.message}
        </p>
      )}
      {preview.location && (
        <p
          data-preview-location
          className="mt-2 select-text break-all border-t border-border pt-2 font-mono text-[11px] leading-4 text-fg-muted"
        >
          {preview.location}
        </p>
      )}
    </div>
  );
}
