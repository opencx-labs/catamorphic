import fs from "node:fs";
import path from "node:path";

const reserveProjectPath = (parentDir: string, slug: string): string => {
  fs.mkdirSync(parentDir, { recursive: true });
  for (let suffix = 1; ; suffix += 1) {
    const candidate = path.join(
      parentDir,
      suffix === 1 ? slug : `${slug}-${suffix}`,
    );
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "EEXIST"
      ) {
        continue;
      }
      throw cause;
    }
  }
};

/** Atomically reserves and provisions a project, rolling it back as one unit. */
export const createReservedProject = async <Project extends object>({
  parentDir,
  slug,
  create,
  provision,
  rollback,
  cleanup,
}: {
  parentDir: string;
  slug: string;
  create: (rootPath: string) => Promise<Project>;
  provision: (input: { project: Project; rootPath: string }) => Promise<void>;
  /** Critical rollback. Throw to retain the folder for recovery. */
  rollback: (input: { project: Project; rootPath: string }) => Promise<void>;
  /** Metadata cleanup after the project and folder no longer exist. */
  cleanup: (input: { project: Project; rootPath: string }) => Promise<void>;
}): Promise<{ project: Project; rootPath: string }> => {
  const rootPath = reserveProjectPath(parentDir, slug);
  let project: Project;
  try {
    project = await create(rootPath);
  } catch (cause) {
    fs.rmSync(rootPath, { recursive: true, force: true });
    throw cause;
  }

  try {
    await provision({ project, rootPath });
    return { project, rootPath };
  } catch (cause) {
    try {
      await rollback({ project, rootPath });
    } catch (rollbackCause) {
      throw new AggregateError(
        [cause, rollbackCause],
        "Project setup failed and could not be rolled back",
      );
    }
    fs.rmSync(rootPath, { recursive: true, force: true });
    try {
      await cleanup({ project, rootPath });
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Project setup failed and metadata cleanup was incomplete",
      );
    }
    throw cause;
  }
};
