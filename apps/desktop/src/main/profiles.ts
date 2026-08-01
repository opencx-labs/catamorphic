import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Chrome-style profiles. Each profile owns:
 *  - a persistent Chromium session partition (cookies, logins, storage) —
 *    signing into Google once in a profile keeps you signed in there,
 *  - its own set of projects (with one default project),
 *  - its own browsing history and password/autofill scope.
 *
 * Stored as plain JSON at `<userData>/profiles.json`. Projects claim a
 * profile at creation time; projects from before profiles existed are
 * adopted by the default profile lazily (see `profileForProject`).
 */
export interface Profile {
  id: string;
  name: string;
  /** Accent chip color (any CSS color); Chrome-style visual identity. */
  color: string;
  projectIds: string[];
  defaultProjectId?: string;
}

export interface ProfilesFile {
  profiles: Profile[];
  defaultProfileId: string;
}

const PROFILE_COLORS: string[] = [
  "#f95225",
  "#4c8dff",
  "#3dba7c",
  "#c465e0",
  "#e0b23f",
  "#e05656",
];
const FALLBACK_COLOR = "#f95225";

export class ProfilesStore {
  private data: ProfilesFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): ProfilesFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (
        Array.isArray(raw?.profiles) &&
        raw.profiles.length > 0 &&
        typeof raw?.defaultProfileId === "string"
      ) {
        return raw as ProfilesFile;
      }
    } catch {
      // First run.
    }
    const initial: Profile = {
      id: randomUUID(),
      name: "Default",
      color: FALLBACK_COLOR,
      projectIds: [],
    };
    return { profiles: [initial], defaultProfileId: initial.id };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  list(): ProfilesFile {
    return this.data;
  }

  get(id: string): Profile | undefined {
    return this.data.profiles.find((profile) => profile.id === id);
  }

  defaultProfile(): Profile {
    const found = this.get(this.data.defaultProfileId) ?? this.data.profiles[0];
    if (!found) throw new Error("profiles store is empty");
    return found;
  }

  create(name: string): Profile {
    const used = new Set(this.data.profiles.map((profile) => profile.color));
    const color =
      PROFILE_COLORS.find((candidate) => !used.has(candidate)) ??
      PROFILE_COLORS[this.data.profiles.length % PROFILE_COLORS.length] ??
      FALLBACK_COLOR;
    const profile: Profile = {
      id: randomUUID(),
      name: name.trim() || `Profile ${this.data.profiles.length + 1}`,
      color,
      projectIds: [],
    };
    this.data.profiles.push(profile);
    this.save();
    return profile;
  }

  update(
    id: string,
    patch: Partial<Pick<Profile, "name" | "color" | "defaultProjectId">>,
  ): Profile | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    if (patch.name !== undefined) profile.name = patch.name.trim() || profile.name;
    if (patch.color !== undefined) profile.color = patch.color;
    if ("defaultProjectId" in patch) {
      profile.defaultProjectId = patch.defaultProjectId;
    }
    this.save();
    return profile;
  }

  setDefaultProfile(id: string): void {
    if (this.get(id)) {
      this.data.defaultProfileId = id;
      this.save();
    }
  }

  /** The last profile cannot be removed; its projects move to the default. */
  remove(id: string): boolean {
    if (this.data.profiles.length <= 1) return false;
    const removed = this.get(id);
    if (!removed) return false;
    this.data.profiles = this.data.profiles.filter(
      (profile) => profile.id !== id,
    );
    const first = this.data.profiles[0];
    if (this.data.defaultProfileId === id && first) {
      this.data.defaultProfileId = first.id;
    }
    const fallback = this.defaultProfile();
    fallback.projectIds.push(...removed.projectIds);
    this.save();
    return true;
  }

  claimProject(profileId: string, projectId: string): void {
    const profile = this.get(profileId) ?? this.defaultProfile();
    if (!profile.projectIds.includes(projectId)) {
      profile.projectIds.push(projectId);
      profile.defaultProjectId ??= projectId;
      this.save();
    }
  }

  releaseProject(projectId: string): void {
    let changed = false;
    for (const profile of this.data.profiles) {
      const before = profile.projectIds.length;
      profile.projectIds = profile.projectIds.filter(
        (candidate) => candidate !== projectId,
      );
      if (profile.projectIds.length !== before) changed = true;
      if (profile.defaultProjectId === projectId) {
        profile.defaultProjectId = profile.projectIds[0];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Pre-profile projects belong to the default profile (lazy adoption). */
  profileForProject(projectId: string): Profile {
    const owner = this.data.profiles.find((profile) =>
      profile.projectIds.includes(projectId),
    );
    if (owner) return owner;
    const fallback = this.defaultProfile();
    fallback.projectIds.push(projectId);
    this.save();
    return fallback;
  }
}
