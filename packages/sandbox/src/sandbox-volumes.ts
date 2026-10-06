import fs from "node:fs";
import path from "node:path";
import { type SandboxVolume, VOLUME_KEY_PATTERN } from "./types.js";

/**
 * Check the volumes a sandbox is handed (ADR 0207): keys from `volumeKey`,
 * absolute or `~/` paths without `..`, not the root, and no volume at or
 * inside another's path (`~` and `~/.cache` cannot both be volumes: one
 * would be mounted into the other, which providers cannot do alike).
 * Providers that know the image user's home check again with `~` resolved.
 */
export function assertSandboxVolumes(
  volumes: readonly SandboxVolume[] | undefined,
): void {
  const seen: string[] = [];
  for (const volume of volumes ?? []) {
    if (!VOLUME_KEY_PATTERN.test(volume.key))
      throw new Error(`'${volume.key}' is not a volume key`);
    if (
      volume.path !== "~" &&
      !volume.path.startsWith("~/") &&
      !volume.path.startsWith("/")
    )
      throw new Error(
        `Volume path '${volume.path}' must be absolute or start with ~/`,
      );
    const segments = volume.path.split("/");
    if (segments.includes(".."))
      throw new Error(`Volume path '${volume.path}' may not contain '..'`);
    // One spelling per place: no empty or `.` segments, no trailing slash.
    const normalized = segments
      .filter((segment, index) => index === 0 || (segment && segment !== "."))
      .join("/");
    if (normalized === "" || normalized === "/")
      throw new Error("A volume cannot be the root directory");
    const other = seen.find(
      (path) =>
        path === normalized ||
        normalized.startsWith(`${path}/`) ||
        path.startsWith(`${normalized}/`),
    );
    if (other === normalized)
      throw new Error(`Two volumes share the path '${volume.path}'`);
    if (other !== undefined)
      throw new Error(
        `Volume paths '${other}' and '${normalized}' are nested; give each volume a directory of its own`,
      );
    seen.push(normalized);
  }
}

/**
 * The home of an image's user, where `~` volume paths go: the image's
 * `HOME`, root's for root (or no user), `/home/<name>` for a named user.
 * Empty for a numeric user without `HOME`, whose home nothing names.
 */
export function imageUserHome(image: {
  user?: string | null;
  env?: readonly string[] | null;
}): string {
  const fromEnv = (image.env ?? [])
    .find((entry) => entry.startsWith("HOME="))
    ?.slice("HOME=".length);
  if (fromEnv) return fromEnv.replace(/\/+$/, "") || "/";
  const name = (image.user ?? "").split(":")[0] ?? "";
  if (!name || name === "root" || name === "0") return "/root";
  if (/^\d+$/.test(name)) return "";
  return `/home/${name}`;
}

/** A volume's path inside the sandbox, `~` resolved against `home`. */
export function volumeMountPath(volume: {
  path: string;
  home: string;
}): string {
  if (volume.path !== "~" && !volume.path.startsWith("~/")) return volume.path;
  if (!volume.home)
    throw new Error(
      `The image's user has no known home, so '${volume.path}' cannot be placed; set HOME in the image or use an absolute path`,
    );
  return volume.path === "~"
    ? volume.home
    : `${volume.home}/${volume.path.slice(2)}`;
}

/**
 * When each volume on a machine was last mounted (ADR 0207), kept in one
 * small JSON file beside the provider's state, so `prune` can forget
 * volumes nobody used for a long time. Providers touch a volume whenever a
 * sandbox mounts it.
 */
export class VolumeUsageLog {
  constructor(private readonly file: string) {}

  /** Record that these volumes were mounted at `at` (now by default). */
  touch(keys: readonly string[], at: number = Date.now()): void {
    if (keys.length === 0) return;
    const entries = this.entries();
    for (const key of keys) entries[key] = Math.max(entries[key] ?? 0, at);
    this.write(entries);
  }

  /** Milliseconds since the epoch, or undefined for a volume never recorded. */
  lastUsed(key: string): number | undefined {
    return this.entries()[key];
  }

  forget(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const entries = this.entries();
    for (const key of keys) delete entries[key];
    this.write(entries);
  }

  entries(): Record<string, number> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  }

  /**
   * Whether a volume is due for removal: not used for `unusedForMs`. A
   * volume the log does not know counts from `since` (its creation), so a
   * lost log never removes a volume at once.
   */
  unused(args: {
    key: string;
    unusedForMs: number;
    since?: number;
    now?: number;
  }): boolean {
    const last = this.lastUsed(args.key) ?? args.since ?? args.now;
    return (args.now ?? Date.now()) - (last ?? Date.now()) >= args.unusedForMs;
  }

  private write(entries: Record<string, number>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
