import fs from "node:fs";
import path from "node:path";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/git";

/**
 * The project manifest (`.catamorphic/project.json`) is the committed home
 * of project-scoped config (ADR 0043). This module reads and writes the
 * `defaultAgent` key (ADR 0056): the slug of the committed project agent
 * that answers new chats for every collaborator, unless a user's own
 * per-project override (agents.json `projectDefaults`) says otherwise.
 *
 * Reads are synchronous — the coding-agent registry contract is — and
 * writes preserve unknown keys, prefs.json-style: the manifest belongs to
 * the project, not to this build's idea of it.
 */

function manifestFile(rootPath: string): string {
  return path.join(rootPath, PROJECT_MANIFEST_PATH);
}

function readManifest(rootPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile(rootPath), "utf-8"));
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or broken manifest — a project without one has no config.
  }
  return {};
}

export interface ProjectStartingAction {
  label: string;
  prompt: string;
  agent?: string;
}

/**
 * Minimal, project-authored New Tab starters for the current member segment.
 * Invalid entries disappear individually and an absent list leaves no UI.
 */
export function projectStartingActions(
  rootPath: string,
  segment: "member" | "builder",
): ProjectStartingAction[] {
  const value = readManifest(rootPath).startingActions;
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const action = entry;
      if (
        typeof action.label !== "string" ||
        action.label.trim().length === 0 ||
        typeof action.prompt !== "string" ||
        action.prompt.trim().length === 0
      ) {
        return [];
      }
      if (
        Array.isArray(action.segments) &&
        !action.segments.includes(segment) &&
        !action.segments.includes("all")
      ) {
        return [];
      }
      return [
        {
          label: action.label.trim().slice(0, 80),
          prompt: action.prompt.trim().slice(0, 20_000),
          ...(typeof action.agent === "string" && action.agent.trim()
            ? { agent: action.agent.trim() }
            : {}),
        },
      ];
    })
    .slice(0, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether this project's members may open incognito sessions (ADR 0062).
 * Default true; a team that wants ALL history synced and usage tracked
 * commits `"allowIncognito": false`. Honored by clients — the mirror is
 * a client push, so this is policy, not cryptography.
 */
export function projectAllowsIncognito(rootPath: string): boolean {
  return readManifest(rootPath).allowIncognito !== false;
}

/** The committed default agent's slug, when the manifest declares one. */
export function projectDefaultAgentSlug(rootPath: string): string | undefined {
  const value = readManifest(rootPath).defaultAgent;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Set (or with null clear) the committed default agent slug. */
export function setProjectDefaultAgentSlug(
  rootPath: string,
  slug: string | null,
): void {
  const manifest = readManifest(rootPath);
  if (slug === null) {
    if (!("defaultAgent" in manifest)) return;
    delete manifest.defaultAgent;
  } else {
    manifest.defaultAgent = slug;
  }
  const file = manifestFile(rootPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
