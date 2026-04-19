/**
 * Upload playground workspace files using hydrateWorkspace when supported,
 * and fall back to per-file uploads for providers without hydration support.
 */
import type { SandboxProvider } from "@catamorphic/sandbox";
import { createTarArchive } from "./tar.js";

type HydratableProvider = SandboxProvider & {
  hydrateWorkspace: (sandboxId: string, tar: Uint8Array) => Promise<void>;
};

function hasHydrateWorkspace(
  provider: SandboxProvider,
): provider is HydratableProvider {
  return (
    typeof (provider as Partial<HydratableProvider>).hydrateWorkspace ===
    "function"
  );
}

function toWorkspaceRelativePath(
  provider: SandboxProvider,
  absolutePath: string,
): string | null {
  const root = provider.workspaceRoot.replace(/\/+$/, "");
  if (absolutePath === root) return "";
  if (!absolutePath.startsWith(`${root}/`)) return null;
  return absolutePath.slice(root.length + 1);
}

export async function uploadWorkspace(opts: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  files: Record<string, string>;
}): Promise<void> {
  if (!hasHydrateWorkspace(opts.provider)) {
    console.info(
      `[PlaygroundExecutor] workspace_upload_mode=fallback reason=no_hydrate_provider sandbox_id=${opts.sandboxId}`,
    );
    await opts.provider.uploadFiles(opts.sandboxId, opts.files, opts.projectDir);
    return;
  }

  const relativeRoot = toWorkspaceRelativePath(opts.provider, opts.projectDir);
  if (!relativeRoot) {
    console.info(
      `[PlaygroundExecutor] workspace_upload_mode=fallback reason=non_workspace_path sandbox_id=${opts.sandboxId}`,
    );
    await opts.provider.uploadFiles(opts.sandboxId, opts.files, opts.projectDir);
    return;
  }

  const archiveEntries = Object.entries(opts.files).map(([filePath, content]) => ({
    path: `${relativeRoot}/${filePath}`.replace(/\/+/g, "/"),
    content,
  }));

  try {
    const tar = createTarArchive(archiveEntries);
    await opts.provider.hydrateWorkspace(opts.sandboxId, tar);
    console.info(
      `[PlaygroundExecutor] workspace_upload_mode=hydrate sandbox_id=${opts.sandboxId} files=${archiveEntries.length}`,
    );
  } catch {
    // Keep old behavior as a safe fallback in case hydration fails.
    console.info(
      `[PlaygroundExecutor] workspace_upload_mode=fallback reason=hydrate_failed sandbox_id=${opts.sandboxId}`,
    );
    await opts.provider.uploadFiles(opts.sandboxId, opts.files, opts.projectDir);
  }
}
