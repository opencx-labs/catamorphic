import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  accessBeyond,
  type CodeAccess,
  isEmptyAccess,
} from "../shared/code-access.js";
import {
  type SidebarSourceRequest,
  sidebarSourceEffect,
} from "../shared/sidebar-source.js";
import {
  sanitizeSidebarSourceItem,
  sanitizeSidebarSourcePage,
} from "../shared/source-rows.js";
import { insideProject, readModuleAccess } from "./module-access.js";
import { launchConfinedModule } from "./module-sandbox.js";
import { SidebarSourceRuntime } from "./sidebar-source-runtime.js";
import { validateWorkspaceSource } from "./workspace-config.js";

const execute = promisify(execFile);
export interface CustomizationDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
}

/** Static compiler checks never execute the project's scripts or source modules. */
export async function checkCustomization({
  projectRoot,
  sourcePath,
  workspacePath,
  sdkRoot,
  bunPath = "bun",
  kind = "source",
}: {
  projectRoot: string;
  sourcePath?: string;
  workspacePath?: string;
  sdkRoot: string;
  bunPath?: string;
  kind?: "source" | "workflow";
}) {
  const diagnostics: CustomizationDiagnostic[] = [];
  const files = [sourcePath, workspacePath].flatMap((entry) =>
    entry ? [path.resolve(projectRoot, entry)] : [],
  );
  if (!files.length)
    throw new Error("Name a source or workspace file to check.");
  if (
    sourcePath &&
    !insideProject(projectRoot, path.resolve(projectRoot, sourcePath))
  )
    throw new Error("A source must be inside its project.");
  if (workspacePath) {
    const filename = path.resolve(projectRoot, workspacePath);
    try {
      validateWorkspaceSource({
        source: await fs.readFile(filename, "utf8"),
        filename,
      });
    } catch (cause) {
      diagnostics.push({
        file: filename,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  if (sourcePath) {
    try {
      readModuleAccess({
        projectRoot,
        modulePath: path.resolve(projectRoot, sourcePath),
      });
    } catch (cause) {
      diagnostics.push({
        file: sourcePath,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-customization-check-"),
  );
  try {
    const wrapper = path.join(temporary, "contract.ts");
    const statements = [
      "import type { SidebarSourceModule, WorkspaceConfig } from '@catamorphic/work-customization';",
    ];
    if (sourcePath && kind === "source")
      statements.push(
        `import source from ${JSON.stringify(path.resolve(projectRoot, sourcePath))};`,
        "source satisfies SidebarSourceModule;",
      );
    if (workspacePath)
      statements.push(
        `import layout from ${JSON.stringify(path.resolve(projectRoot, workspacePath))};`,
        "layout satisfies WorkspaceConfig;",
      );
    await fs.writeFile(wrapper, statements.join("\n"));
    const sdkModules = path.join(sdkRoot, "node_modules");
    const hostTypes = path.join(sdkRoot, "work-triggers.d.ts");
    const typeFiles = await fs.access(hostTypes).then(
      () => [hostTypes],
      () => [],
    );
    await fs.writeFile(
      path.join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          allowJs: true,
          checkJs: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          lib: ["ES2022", "DOM"],
          types: ["node", "bun"],
          typeRoots: [path.join(sdkModules, "@types")],
          paths: Object.fromEntries(
            ["work-customization", "app", "agent-protocol", "workflow"].map(
              (name) => [
                `@catamorphic/${name}`,
                [path.join(sdkModules, `@catamorphic/${name}/dist/index.d.ts`)],
              ],
            ),
          ),
        },
        files: [wrapper, ...files, ...typeFiles],
        include: [],
        exclude: [],
      }),
    );
    try {
      await execute(
        bunPath,
        [
          "check",
          "--no-script",
          "--no-pretty",
          "--project",
          path.join(temporary, "tsconfig.json"),
        ],
        {
          cwd: projectRoot,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
          env: { PATH: process.env.PATH ?? "" },
        },
      );
    } catch (cause) {
      const previousDiagnostics = diagnostics.length;
      const stdout =
        typeof cause === "object" &&
        cause !== null &&
        "stdout" in cause &&
        typeof cause.stdout === "string"
          ? cause.stdout
          : "";
      const stderr =
        typeof cause === "object" &&
        cause !== null &&
        "stderr" in cause &&
        typeof cause.stderr === "string"
          ? cause.stderr
          : "";
      for (const line of `${stdout}\n${stderr}`.split("\n").filter(Boolean)) {
        const match = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
        if (match)
          diagnostics.push({
            file: path.resolve(projectRoot, match[1] ?? ""),
            line: Number(match[2]),
            column: Number(match[3]),
            code: match[4],
            message: match[5] ?? line,
          });
      }
      if (diagnostics.length === previousDiagnostics)
        diagnostics.push({
          message:
            stderr ||
            stdout ||
            (cause instanceof Error ? cause.message : String(cause)),
        });
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return { ok: diagnostics.length === 0, diagnostics, files };
}

/** The preview uses the live worker, sandbox, declaration and row validator. */
export async function previewCustomization({
  projectRoot,
  sourcePath,
  workerPath,
  scratchRoot,
  toolchain,
  approvedAccess = {},
  request = {},
  work,
  blocked,
  cleanup,
}: {
  projectRoot: string;
  sourcePath: string;
  workerPath: string;
  scratchRoot: string;
  toolchain: Record<string, string>;
  approvedAccess?: CodeAccess;
  request?: Partial<SidebarSourceRequest>;
  work?: (requestId: string, call: unknown) => Promise<unknown>;
  blocked?: (host: string, port: number) => boolean;
  cleanup?: () => Promise<void>;
}) {
  const modulePath = path.resolve(projectRoot, sourcePath);
  const declaration = readModuleAccess({ projectRoot, modulePath });
  const beyond = accessBeyond(approvedAccess, declaration.access);
  if (!isEmptyAccess(beyond)) return { ok: false, accessRequired: beyond };
  const runtime = new SidebarSourceRuntime({
    projectRoot,
    modulePath,
    work,
    watchFiles: declaration.file ? [declaration.file] : [],
    launch: () =>
      launchConfinedModule({
        projectRoot,
        modulePath,
        workerPath,
        scratchRoot,
        access: declaration.access,
        toolchain,
        executable: toolchain.CATAMORPHIC_BUN ?? "bun",
        blocked,
      }),
  });
  try {
    const result = await runtime.request({
      ...request,
      projectId: request.projectId ?? "preview",
      sectionId: request.sectionId ?? "preview",
      requestId: crypto.randomUUID(),
      method: request.method ?? "load",
    });
    return {
      ok: true,
      result:
        request.method === "action"
          ? (sidebarSourceEffect(result) ?? null)
          : request.method === "reveal"
            ? result == null
              ? null
              : sanitizeSidebarSourceItem(result, new Set(), {
                  apps: declaration.access.lists?.includes("apps"),
                })
            : request.method === "move" || request.method === "drop"
              ? null
              : sanitizeSidebarSourcePage(result, {
                  apps: declaration.access.lists?.includes("apps"),
                }),
      runtime: runtime.inspect(),
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      runtime: runtime.inspect(),
    };
  } finally {
    runtime.dispose();
    await cleanup?.();
  }
}
