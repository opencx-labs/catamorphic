import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EXTENSION_ID_PATTERN } from "../../shared/extensions.js";

/**
 * A profile's installed extensions (ADR 0203), in
 * `profiles/<id>/extensions.json`. Store packages unpack under
 * `profiles/<id>/extensions/<extension id>/<version>_0/`, beside the
 * extension's `storage.sync` data; unpacked ones load from their folder.
 */

const permissionSetSchema = z.object({
  permissions: z.array(z.string()).default([]),
  origins: z.array(z.string()).default([]),
});

const installedSchema = z.object({
  id: z.string().regex(EXTENSION_ID_PATTERN),
  source: z.enum(["webstore", "unpacked"]),
  path: z.string().min(1),
  version: z.string(),
  enabled: z.boolean(),
  /** Set when not running for a reason other than the person's toggle. */
  disabledReason: z.enum(["user", "permissions", "error"]).nullable(),
  pinned: z.boolean(),
  installedAt: z.number(),
  updatedAt: z.number(),
  /** The access the person accepted (see `accessOf` in manifest.ts). */
  approved: permissionSetSchema,
  /** Optional permissions granted while it ran. */
  granted: permissionSetSchema.default({ permissions: [], origins: [] }),
  /**
   * The static rulesets this version last had enabled, restored each time
   * it starts; null until it first starts, when the manifest's defaults
   * apply (at install and after each update, as in Chrome).
   */
  enabledRulesets: z.array(z.string()).nullable().default(null),
  /** A downloaded update waiting for the person to accept new access. */
  pendingUpdate: z
    .object({
      version: z.string(),
      path: z.string(),
      warnings: z.array(z.string()),
    })
    .nullable()
    .default(null),
  uninstallUrl: z.string().nullable().default(null),
  /** The version `runtime.onInstalled` was delivered for (null: never). */
  installedEventFor: z.string().nullable().default(null),
  /**
   * A downloaded update that asks for nothing new, waiting for the running
   * version to be idle (or for the next start).
   */
  stagedUpdate: z
    .object({
      version: z.string(),
      path: z.string(),
      approved: permissionSetSchema,
    })
    .nullable()
    .default(null),
});
export type InstalledExtension = z.infer<typeof installedSchema>;

const profileSchema = z.object({
  developerMode: z.boolean().default(false),
  lastUpdateCheck: z.number().nullable().default(null),
  extensions: z.array(z.unknown()).default([]),
});

interface ProfileExtensions {
  developerMode: boolean;
  lastUpdateCheck: number | null;
  extensions: InstalledExtension[];
  /** Entries this version can't read, kept as they were. */
  unreadable: unknown[];
}

export class ExtensionRegistry {
  private cache = new Map<string, ProfileExtensions>();

  constructor(private readonly profilesDir: string) {}

  private file(profileId: string): string {
    return path.join(this.profilesDir, profileId, "extensions.json");
  }

  /** Where a profile's store packages and per-extension data live. */
  dataDir(profileId: string, extensionId?: string): string {
    const root = path.join(this.profilesDir, profileId, "extensions");
    if (extensionId === undefined) return root;
    if (!EXTENSION_ID_PATTERN.test(extensionId))
      throw new Error("Invalid extension id");
    return path.join(root, extensionId);
  }

  private load(profileId: string): ProfileExtensions {
    const cached = this.cache.get(profileId);
    if (cached) return cached;
    let loaded: ProfileExtensions = {
      developerMode: false,
      lastUpdateCheck: null,
      extensions: [],
      unreadable: [],
    };
    const file = this.file(profileId);
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      /* A profile without extensions has no file yet. */
    }
    if (text !== null) {
      try {
        const parsed = profileSchema.parse(JSON.parse(text));
        const extensions: InstalledExtension[] = [];
        const unreadable: unknown[] = [];
        // One damaged entry must not cost the others, and is kept as it
        // was rather than forgotten on the next save.
        for (const entry of parsed.extensions) {
          const result = installedSchema.safeParse(entry);
          if (result.success) extensions.push(result.data);
          else unreadable.push(entry);
        }
        loaded = {
          developerMode: parsed.developerMode,
          lastUpdateCheck: parsed.lastUpdateCheck,
          extensions,
          unreadable,
        };
      } catch (cause) {
        // A file that doesn't parse moves aside, so the next save can't
        // overwrite the list it held.
        const aside = `${file}.damaged-${Date.now()}`;
        try {
          fs.renameSync(file, aside);
        } catch {
          // Saving will try again.
        }
        console.warn(
          `[extensions] ${file} could not be read and was moved to ${aside}:`,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    }
    this.cache.set(profileId, loaded);
    return loaded;
  }

  private save(profileId: string): void {
    const { unreadable, extensions, ...rest } = this.load(profileId);
    const file = this.file(profileId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = { ...rest, extensions: [...extensions, ...unreadable] };
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(`${file}.tmp`, file);
  }

  list(profileId: string): readonly InstalledExtension[] {
    return this.load(profileId).extensions;
  }

  get(profileId: string, id: string): InstalledExtension | null {
    return this.list(profileId).find((entry) => entry.id === id) ?? null;
  }

  put(profileId: string, extension: InstalledExtension): void {
    const data = this.load(profileId);
    const index = data.extensions.findIndex(
      (entry) => entry.id === extension.id,
    );
    if (index < 0) data.extensions.push(extension);
    else data.extensions[index] = extension;
    this.save(profileId);
  }

  update(
    profileId: string,
    id: string,
    change: (extension: InstalledExtension) => InstalledExtension,
  ): InstalledExtension | null {
    const current = this.get(profileId, id);
    if (!current) return null;
    const next = change(current);
    this.put(profileId, next);
    return next;
  }

  remove(profileId: string, id: string): void {
    const data = this.load(profileId);
    data.extensions = data.extensions.filter((entry) => entry.id !== id);
    this.save(profileId);
  }

  developerMode(profileId: string): boolean {
    return this.load(profileId).developerMode;
  }

  setDeveloperMode(profileId: string, enabled: boolean): void {
    this.load(profileId).developerMode = enabled;
    this.save(profileId);
  }

  lastUpdateCheck(profileId: string): number | null {
    return this.load(profileId).lastUpdateCheck;
  }

  setLastUpdateCheck(profileId: string, at: number): void {
    this.load(profileId).lastUpdateCheck = at;
    this.save(profileId);
  }

  releaseProfile(profileId: string): void {
    this.cache.delete(profileId);
  }
}
