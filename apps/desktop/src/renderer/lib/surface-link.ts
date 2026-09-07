/** Agent links use the same targets as open_surface and the workspace tab keys. */
export type SurfaceLink =
  | { kind: "browser"; url: string }
  | { kind: "file"; path: string; line?: number; column?: number }
  | { kind: "workflow" | "app"; name: string }
  | { kind: "tab"; key: string };

export function parseSurfaceLink(value: string): SurfaceLink | null {
  const href = value.trim();
  if (!href || [...href].some((char) => char.charCodeAt(0) < 32)) return null;
  try {
    if (/^https?:\/\//i.test(href)) {
      return { kind: "browser", url: new URL(href).href };
    }
    const resource = /^(workflow|app):(.+)$/i.exec(href);
    if (resource) {
      const kind = resource[1]?.toLowerCase();
      const name = decodeURIComponent(resource[2] ?? "");
      if (
        (kind === "workflow" || kind === "app") &&
        name &&
        !name.startsWith("//")
      ) {
        return { kind, name };
      }
      return null;
    }
    if (/^(chat|browser|terminal|editor|diff|mcpapp):[^\s]+$/.test(href)) {
      return { kind: "tab", key: href };
    }
    const fileUrl = /^file:\/\//i.test(href) ? new URL(href) : null;
    if (fileUrl?.hostname && fileUrl.hostname !== "localhost") return null;
    const raw = fileUrl
      ? `${fileUrl.pathname}${fileUrl.hash}`
      : href.replace(/^file:/i, "");
    const anchor = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/.exec(
      raw,
    );
    const pathPart = anchor ? raw.slice(0, anchor.index) : raw;
    // Strip source locations before testing schemes (index.ts:12 is a file).
    if (
      !fileUrl &&
      !/^file:/i.test(href) &&
      (/^[a-z][a-z\d+.-]*:/i.test(pathPart) ||
        pathPart.startsWith("#") ||
        pathPart.startsWith("//"))
    )
      return null;
    const path = decodeURIComponent(anchor ? raw.slice(0, anchor.index) : raw);
    if (
      !path ||
      (!path.includes("/") && !path.includes(".") && !/^file:/i.test(href))
    )
      return null;
    const line = Number(anchor?.[1] ?? anchor?.[3]);
    const column = Number(anchor?.[2] ?? anchor?.[4]);
    return {
      kind: "file",
      path,
      ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
      ...(Number.isSafeInteger(column) && column > 0 ? { column } : {}),
    };
  } catch {
    return null;
  }
}

export const isBrowserFile = (path: string) =>
  /\.(pdf|html?|svg|png|jpe?g|gif|webp|avif|ico|mp4|webm|mov|mp3|wav|ogg|m4a)$/i.test(
    path,
  );

export function resolveProjectFileLocation(
  projectRoot: string,
  filePath: string,
) {
  const root = projectRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const path = filePath.replaceAll("\\", "/");
  const url = new URL("file:///");
  url.pathname =
    path.startsWith("/") || /^[A-Za-z]:\//.test(path)
      ? path
      : `${root}/${path}`;
  const absolutePath = decodeURIComponent(url.pathname);
  return {
    absolutePath,
    relativePath: absolutePath.startsWith(`${root}/`)
      ? absolutePath.slice(root.length + 1)
      : absolutePath,
  };
}

export function localFileUrl(absolutePath: string) {
  const url = new URL("file:///");
  url.pathname = absolutePath;
  return url.href;
}
