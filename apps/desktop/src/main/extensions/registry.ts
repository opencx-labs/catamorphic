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
  /** The warnings the person accepted for this version. */
  approvedWarnings: z.array(z.string()),
  /** Optional permissions granted while it ran. */
  granted: permissionSetSchema.default({ permissions: [], origins: [] }),
  /** The version whose default rulesets were last applied. */
  rulesetsAppliedFor: z.string().nullable().default(null),
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
    };
    try {
      const parsed = profileSchema.parse(
        JSON.parse(fs.readFileSync(this.file(profileId), "utf-8")),
      );
      loaded = {
        developerMode: parsed.developerMode,
        lastUpdateCheck: parsed.lastUpdateCheck,
        // One damaged entry must not cost the others.
        extensions: parsed.extensions.flatMap((entry) => {
          const result = installedSchema.safeParse(entry);
          return result.success ? [result.data] : [];
        }),
      };
    } catch {
      /* A profile without extensions has no file yet. */
    }
    this.cache.set(profileId, loaded);
    return loaded;
  }

  private save(profileId: string): void {
    const data = this.load(profileId);
    const file = this.file(profileId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
