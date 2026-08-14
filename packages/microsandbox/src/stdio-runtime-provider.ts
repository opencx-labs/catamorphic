import {
  StdioDeploymentRuntimeProvider,
  type SupervisorProcessHandle,
} from "@catamorphic/sandbox";
import type { ExecHandle, Sandbox } from "microsandbox";

export interface MsbStdioTransportOptions {
  connect: (sandboxId: string) => Promise<Sandbox>;
  uploadFiles: (
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ) => Promise<void>;
}

/**
 * The generic stdio deployment runtime (`@catamorphic/sandbox`) over
 * microsandbox's exec-stream channel: `bun run entry.mjs` inside the
 * sandbox, frames over the exec stream's stdin/stdout.
 */
export function msbStdioRuntimeProvider(
  options: MsbStdioTransportOptions,
): StdioDeploymentRuntimeProvider {
  return new StdioDeploymentRuntimeProvider({
    uploadFiles: options.uploadFiles,
    mkdirp: async (sandboxId, directory) => {
      const sandbox = await options.connect(sandboxId);
      await sandbox.shell(`mkdir -p '${directory.replaceAll("'", `'\\''`)}'`);
    },
    openSupervisor: async (args) => {
      const sandbox = await options.connect(args.sandboxId);
      const handle = await sandbox.execStreamWith("bun", (exec) =>
        exec
          .args(["run", "entry.mjs"])
          .cwd(args.runtimeDirectory)
          .envs(args.env)
          .stdinPipe(),
      );
      const stdin = await handle.takeStdin();
      if (!stdin) {
        await handle.kill().catch(() => {});
        throw new Error("Supervisor exec stream has no stdin sink");
      }
      return {
        write: (data) => stdin.write(data),
        kill: async () => {
          await handle.kill();
        },
        stdout: execStdout(handle),
      } satisfies SupervisorProcessHandle;
    },
  });
}

async function* execStdout(handle: ExecHandle): AsyncIterable<Uint8Array> {
  for await (const event of handle) {
    if (event.kind === "stdout") yield event.data;
    if (event.kind === "exited") break;
  }
}
