import type {
  AttemptHost,
  HarnessAdapter,
} from "@catamorphic/agent-protocol/runner";
import { remapPaths, type SandboxPathMap } from "@catamorphic/sandbox";

/**
 * An adapter in a sandbox whose provider maps virtual paths onto real
 * directories (local-process, `SANDBOX_PATHS_ENV`): the attempt's paths
 * become real ones before the harness sees them, and the paths the harness
 * reports become virtual again, so the host sees the same paths whatever
 * the sandbox. The attempt's environment keeps its values as they are
 * (they are the session's secrets and variables, ADR 0205), except
 * `BASH_ENV`, which names one of the session's files.
 */
export function withSandboxPaths(
  adapter: HarnessAdapter,
  paths: SandboxPathMap,
): HarnessAdapter {
  const inward = <T>(value: T): T =>
    remapPaths(value, paths.virtual, paths.real);
  const outward = <T>(value: T): T =>
    remapPaths(value, paths.real, paths.virtual);
  return {
    id: adapter.id,
    capabilities: () => adapter.capabilities(),
    start: (attempt, host, local) => {
      const mapped: AttemptHost = {
        emit: (event) => host.emit(outward(event)),
        callTool: async (input) => inward(await host.callTool(outward(input))),
        authorize: (input) => {
          const { signal, ...rest } = input;
          return host.authorize({ ...outward(rest), signal });
        },
        request: (key, request, options) =>
          host.request(key, outward(request), options),
        nativeState: host.nativeState,
        signal: host.signal,
      };
      const { env, ...rest } = attempt;
      return adapter.start(
        {
          ...inward(rest),
          env: {
            ...env,
            ...(env.BASH_ENV ? { BASH_ENV: inward(env.BASH_ENV) } : {}),
          },
        },
        mapped,
        local,
      );
    },
  };
}
