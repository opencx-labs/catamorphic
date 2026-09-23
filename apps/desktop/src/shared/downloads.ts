import { isBrowserFile } from "./surface-link.js";

/**
 * Downloads (ADR 0153): files a browser tab saves. Chrome's model, in
 * Work's places: the dock shows what is in flight, the Downloads page
 * lists everything, and opening a file means opening it in Work when
 * Work can show it, else revealing it in the file manager.
 */

export type DownloadState =
  | "progressing"
  | "paused"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface DownloadRecord {
  id: string;
  filename: string;
  url: string;
  /** Host of the page or URL the file came from, for the row's detail. */
  host: string | null;
  savePath: string;
  mimeType: string;
  /** -1 when the server did not say. */
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  startedAt: number;
  finishedAt: number | null;
  /** The saved file is still on disk (completed downloads only). */
  exists: boolean;
  canResume: boolean;
}

/** Text Chromium renders as plain text; the rest is `isBrowserFile`. */
const TEXT_FILE =
  /\.(txt|md|markdown|json|csv|tsv|log|xml|yaml|yml|toml|ini|js|mjs|cjs|ts|tsx|jsx|css|sh|py|rb|go|rs|java|c|h|cpp|sql|diff|patch)$/i;

/** Work can show this file itself (a browser tab renders it). */
export function downloadOpensInWork(filename: string): boolean {
  return isBrowserFile(filename) || TEXT_FILE.test(filename);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function fileUrlFor(savePath: string): string {
  const url = new URL("file:///");
  url.pathname = savePath.replaceAll("\\", "/");
  return url.href;
}

/** In flight, paused included: what the dock ring sums up. */
export function isActiveDownload(record: DownloadRecord): boolean {
  return record.state === "progressing" || record.state === "paused";
}
