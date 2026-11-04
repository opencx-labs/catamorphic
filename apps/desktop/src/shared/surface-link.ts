/** Agent links use the same targets as open_surface and the workspace tab keys. */
export type SurfaceLink =
  | { kind: "browser"; url: string }
  | { kind: "file"; path: string; line?: number; column?: number }
  | { kind: "workflow" | "app" | "artifact" | "run"; name: string }
  | { kind: "tab"; key: string };

export function parseSurfaceLink(value: string): SurfaceLink | null {
  const href = value.trim();
  if (!href || [...href].some((char) => char.charCodeAt(0) < 32)) return null;
  try {
    if (/^https?:\/\//i.test(href)) {
      return { kind: "browser", url: new URL(href).href };
    }
    const resource = /^(workflow|app|artifact|run):(.+)$/i.exec(href);
    if (resource) {
      const kind = resource[1]?.toLowerCase();
      const name = decodeURIComponent(resource[2] ?? "");
      if (
        (kind === "workflow" ||
          kind === "app" ||
          kind === "artifact" ||
          kind === "run") &&
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

/**
 * Files a browser tab renders, by kind. Finder lists Work under Open With
 * for these and `TEXT_FILE_TYPES` (`mac.fileAssociations` in
 * electron-builder.yml).
 */
export const BROWSER_FILE_TYPES = [
  { name: "PDF document", ext: ["pdf"] },
  { name: "Web page", ext: ["html", "htm"] },
  {
    name: "Image",
    ext: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"],
  },
  { name: "Video", ext: ["mp4", "webm", "mov"] },
  { name: "Audio", ext: ["mp3", "wav", "ogg", "m4a"] },
] as const;

/** Text the editor opens, and a browser tab shows as plain text. */
export const TEXT_FILE_TYPES = [
  { name: "Text", ext: ["txt", "log"] },
  { name: "Markdown", ext: ["md", "markdown"] },
  {
    name: "Data",
    ext: ["json", "csv", "tsv", "xml", "yaml", "yml", "toml", "ini"],
  },
  {
    name: "Source code",
    ext: [
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "css",
      "sh",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "c",
      "h",
      "cpp",
      "sql",
    ],
  },
  { name: "Patch", ext: ["diff", "patch"] },
] as const;

const extensionPattern = (
  types: readonly { readonly ext: readonly string[] }[],
) => new RegExp(`\\.(${types.flatMap((type) => type.ext).join("|")})$`, "i");
const BROWSER_FILE = extensionPattern(BROWSER_FILE_TYPES);
const TEXT_FILE = extensionPattern(TEXT_FILE_TYPES);

export const isBrowserFile = (path: string) => BROWSER_FILE.test(path);
export const isTextFile = (path: string) => TEXT_FILE.test(path);

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
