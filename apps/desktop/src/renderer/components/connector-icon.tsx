import { Plug, Puzzle } from "lucide-react";
import { useState } from "react";

/** The address's own favicon: a manual connection's best likeness. */
function faviconFor(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:"
      ? new URL("/favicon.ico", url).href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A connection's likeness: its registry icon (the spec's `icons` field;
 * only https/data urls reach here, validated server-side), else the
 * favicon of its https address, else a neutral glyph: a plug for MCP
 * servers, a puzzle piece for plugins.
 */
export function ConnectorIcon({
  iconUrl,
  url,
  name,
  kind = "mcp",
  size = "md",
}: {
  iconUrl?: string;
  /** The server's address; a stdio connection has none. */
  url?: string;
  name: string;
  kind?: "mcp" | "plugin";
  size?: "sm" | "md";
}) {
  const sources = [iconUrl, faviconFor(url)].filter(
    (source): source is string => Boolean(source),
  );
  const [failed, setFailed] = useState<string[]>([]);
  const source = sources.find((candidate) => !failed.includes(candidate));
  const Fallback = kind === "plugin" ? Puzzle : Plug;
  return (
    <span
      className={`grid shrink-0 place-items-center overflow-hidden rounded border border-border bg-bg-inset ${size === "sm" ? "size-5" : "size-6"}`}
    >
      {source ? (
        <img
          key={source}
          src={source}
          alt=""
          className="size-full object-contain"
          onError={() => setFailed((current) => [...current, source])}
        />
      ) : (
        <Fallback className="size-3 text-fg-faint" aria-label={name} />
      )}
    </span>
  );
}
