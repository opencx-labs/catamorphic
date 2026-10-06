/**
 * Chrome's match patterns and the URLs an extension may send a tab to
 * (ADR 0203). Extensions open web pages and their own pages; never local
 * files, script URLs, other extensions' pages or Work's internal ones.
 */

const ALL_URLS_SCHEMES = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
  "ftp:",
  "data:",
  "file:",
  "urn:",
]);

interface ParsedPattern {
  scheme: string;
  host: string;
  port: string | null;
  path: string;
}

function parsePattern(pattern: string): ParsedPattern | null {
  if (pattern === "<all_urls>")
    return { scheme: "<all>", host: "*", port: null, path: "/*" };
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!match) return null;
  const [, scheme = "", authority = "", path = "/*"] = match;
  const portMatch = /^(.*?)(?::(\d+|\*))?$/.exec(authority);
  const host = portMatch?.[1] ?? authority;
  if (scheme !== "file" && host === "") return null;
  if (host.includes("*") && host !== "*" && !host.startsWith("*.")) return null;
  return { scheme, host, port: portMatch?.[2] ?? null, path };
}

function globMatch(glob: string, value: string): boolean {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(value);
}

/** Does `url` match the extension match pattern? */
export function matchesPattern(pattern: string, url: string): boolean {
  const parsed = parsePattern(pattern);
  if (!parsed) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (parsed.scheme === "<all>") return ALL_URLS_SCHEMES.has(target.protocol);
  const scheme = target.protocol.slice(0, -1);
  if (parsed.scheme === "*") {
    if (scheme !== "http" && scheme !== "https") return false;
  } else if (parsed.scheme !== scheme) return false;
  if (scheme !== "file") {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (parsed.host !== "*") {
      if (parsed.host.startsWith("*.")) {
        const base = parsed.host.slice(2);
        if (host !== base && !host.endsWith(`.${base}`)) return false;
      } else if (parsed.host !== host) return false;
    }
    if (parsed.port !== null && parsed.port !== "*") {
      const port =
        target.port ||
        (scheme === "https" ? "443" : scheme === "http" ? "80" : "");
      if (port !== parsed.port) return false;
    }
  }
  return globMatch(parsed.path, `${target.pathname}${target.search}`);
}

export function matchesAny(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, url));
}

/** Is every URL `requested` matches also matched by `granted`? */
export function patternCovers(granted: string, requested: string): boolean {
  if (granted === requested || granted === "<all_urls>") return true;
  const outer = parsePattern(granted);
  const inner = parsePattern(requested);
  if (!outer || !inner || inner.scheme === "<all>") return false;
  if (outer.scheme === "*") {
    if (!["*", "http", "https"].includes(inner.scheme)) return false;
  } else if (outer.scheme !== inner.scheme) return false;
  if (outer.host !== "*") {
    if (inner.host === "*") return false;
    if (outer.host.startsWith("*.")) {
      const base = outer.host.slice(2);
      const innerBase = inner.host.replace(/^\*\./, "");
      if (innerBase !== base && !innerBase.endsWith(`.${base}`)) return false;
    } else if (outer.host !== inner.host) return false;
  }
  if (outer.port !== null && outer.port !== "*" && outer.port !== inner.port)
    return false;
  return globMatch(outer.path, inner.path.replaceAll("*", ""));
}

/**
 * Where an extension may send a tab: the normalized URL, or null. An empty
 * URL is a new tab; a relative one names the extension's own page.
 */
export function extensionTabUrl(
  raw: string | undefined,
  extensionId: string,
): string | null {
  const base = `chrome-extension://${extensionId}/`;
  if (raw === undefined || raw === "") return "";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  if (url.href === "about:blank") return url.href;
  if (url.protocol === "chrome-extension:" && url.host === extensionId)
    return url.href;
  return null;
}

/** May an extension drive this page with the debugger, or script it? */
export function scriptableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.href === "about:blank"
    );
  } catch {
    return false;
  }
}
