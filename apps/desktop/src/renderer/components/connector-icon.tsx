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

/** Catalog tiles: a rounded square the mark sits inside, app-icon style. */
const TILES = {
  lg: { box: "size-10 rounded-[10px]", mark: "size-6", letter: "text-[15px]" },
  xl: { box: "size-14 rounded-[14px]", mark: "size-8", letter: "text-xl" },
} as const;

/**
 * A connection's likeness: its registry icon (the spec's `icons` field;
 * only https/data urls reach here, validated server-side), else the
 * favicon of its https address. Without one, list sizes show a neutral
 * glyph (a plug for MCP servers, a puzzle piece for plugins) and catalog
 * tiles show the name's first letter.
 */
export function ConnectorIcon({
  iconUrl,
  url,
  name,
  kind = "mcp",
  size = "md",
}: {
  iconUrl?: string;
  /** The server's address, or a vendor's page; a stdio connection has none. */
  url?: string;
  name: string;
  kind?: "mcp" | "plugin";
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const sources = [iconUrl, faviconFor(url)].filter(
    (source): source is string => Boolean(source),
  );
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const source = sources.find((candidate) => !failed.includes(candidate));
  if (size === "lg" || size === "xl") {
    const tile = TILES[size];
    const letter = name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
    const shown = source !== undefined && loaded === source;
    return (
      <span
        className={`grid shrink-0 place-items-center overflow-hidden bg-bg-raised ring-1 ring-border ring-inset ${tile.box}`}
      >
        {!shown && (
          <span
            aria-hidden="true"
            className={`col-start-1 row-start-1 font-semibold text-fg-muted ${tile.letter}`}
          >
            {letter}
          </span>
        )}
        {source && (
          <img
            key={source}
            src={source}
            alt=""
            loading="lazy"
            className={`col-start-1 row-start-1 object-contain ${tile.mark} ${shown ? "" : "invisible"}`}
            onLoad={() => setLoaded(source)}
            onError={() => setFailed((current) => [...current, source])}
          />
        )}
      </span>
    );
  }
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
