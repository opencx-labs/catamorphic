import type { LucideIcon } from "lucide-react";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type DownloadRecord,
  formatBytes,
  isActiveDownload,
} from "../../shared/downloads.js";
import { desktopApi } from "./desktop-api.js";

export function downloadIcon(filename: string): LucideIcon {
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|heic|bmp|tiff?)$/i.test(filename))
    return FileImage;
  if (/\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(filename)) return FileVideo;
  if (/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(filename)) return FileAudio;
  if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|pkg)$/i.test(filename))
    return FileArchive;
  if (
    /\.(js|mjs|cjs|ts|tsx|jsx|css|html?|json|yaml|yml|toml|sh|py|rb|go|rs|java|c|h|cpp|sql)$/i.test(
      filename,
    )
  )
    return FileCode;
  if (/\.(txt|md|markdown|pdf|csv|tsv|log|xml|docx?|rtf)$/i.test(filename))
    return FileText;
  return File;
}

/** "1.2 MB of 4.0 MB", "4.0 MB · files.test", "Failed · files.test"… */
export function describeDownload(record: DownloadRecord): string {
  const size =
    record.totalBytes > 0
      ? formatBytes(record.totalBytes)
      : record.receivedBytes > 0
        ? formatBytes(record.receivedBytes)
        : "";
  const tail = record.host ? ` · ${record.host}` : "";
  switch (record.state) {
    case "progressing":
      return record.totalBytes > 0
        ? `${formatBytes(record.receivedBytes)} of ${size}`
        : `${formatBytes(record.receivedBytes)} so far`;
    case "paused":
      return `Paused · ${formatBytes(record.receivedBytes)}${
        record.totalBytes > 0 ? ` of ${size}` : ""
      }`;
    case "cancelled":
      return `Cancelled${tail}`;
    case "interrupted":
      return `Failed${tail}`;
    default:
      return record.exists ? `${size}${tail}` : `Deleted${tail}`;
  }
}

/** 0–1 for a download in flight, null when size is unknown or it is done. */
export function downloadProgress(record: DownloadRecord): number | null {
  if (!isActiveDownload(record) || record.totalBytes <= 0) return null;
  return Math.min(1, record.receivedBytes / record.totalBytes);
}

/** The profile's downloads, live: any change from main re-delivers the list. */
export function useDownloads(enabled = true): {
  downloads: DownloadRecord[];
  loaded: boolean;
  refresh: () => Promise<void>;
} {
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setDownloads(await desktopApi.downloadsList());
      setLoaded(true);
    } catch {
      /* The list stays as it was. */
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return desktopApi.onDownloadsChanged((next) => {
      setDownloads(next);
      setLoaded(true);
    });
  }, [enabled, refresh]);
  return { downloads, loaded, refresh };
}
