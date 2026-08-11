import type { SandboxProvider } from "./types.js";

export interface PluginPayload {
  packageName: string;
  files: Record<string, string>;
}

export async function uploadPluginPayloads(opts: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  plugins?: PluginPayload[];
}): Promise<void> {
  for (const plugin of opts.plugins ?? []) {
    assertPackageName(plugin.packageName);
    for (const filePath of Object.keys(plugin.files)) {
      assertRelativeFilePath(filePath);
    }
    if (Object.keys(plugin.files).length === 0) continue;
    await opts.provider.uploadFiles(
      opts.sandboxId,
      plugin.files,
      `${opts.projectDir}/node_modules/${plugin.packageName}`,
    );
  }
}

function assertPackageName(packageName: string): void {
  const valid = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(
    packageName,
  );
  if (!valid) {
    throw new Error(`Invalid plugin package name '${packageName}'`);
  }
}

function assertRelativeFilePath(filePath: string): void {
  const parts = filePath.split("/");
  if (
    filePath.startsWith("/") ||
    filePath.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid plugin file path '${filePath}'`);
  }
}
