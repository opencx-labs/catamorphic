import type { ConnectionGitPolicy } from "./connection-types.js";

/** `org/repo.git/` → `org/repo`; null for traversal and empty paths. */
export function repositoryPath(value: string): string | null {
  const trimmed = value
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const segments = trimmed.split("/");
  if (
    !trimmed ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._~-]+$/.test(segment),
    )
  )
    return null;
  return trimmed;
}

/** A remote URL's path below `base`, normalized, or null when outside it. */
export function repositoryBelow(
  remoteUrl: string,
  base: string,
): string | null {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (!remoteUrl.startsWith(prefix)) return null;
  return repositoryPath(remoteUrl.slice(prefix.length));
}

/**
 * The repositories a Git-serving binding reaches (ADR 0175), as paths below
 * the provider's remote bases (`org/repo`): the binding's own
 * `git.repositories`, else the project's linked remote when it sits under
 * one of `bases`. The Git gateway and a provider's API actions enforce the
 * same set.
 */
export function bindingRepositories(args: {
  policy: ConnectionGitPolicy | undefined;
  bases: readonly string[];
  projectRemote: string | null | undefined;
}): string[] {
  if (args.policy?.repositories)
    return args.policy.repositories.flatMap((path) => {
      const normalized = repositoryPath(path);
      return normalized ? [normalized] : [];
    });
  const origin = args.projectRemote;
  if (!origin) return [];
  return args.bases.flatMap((base) => {
    const path = repositoryBelow(origin, base);
    return path ? [path] : [];
  });
}
