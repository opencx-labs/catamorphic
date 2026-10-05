import fs from "node:fs";
import path from "node:path";
import type { DockerClient } from "./docker-client.js";

/** What a gVisor runtime was registered with (ADR 0203). */
export interface RunscFeatures {
  /** `--host-uds=open` (or `all`): sandboxes reach a mounted host socket, so egress policy works. */
  hostSockets: boolean;
  /** `--net-raw`: the nested Docker daemon gets the raw sockets it needs. */
  netRaw: boolean;
}

/** The container runtime sandboxes run under. */
export type ContainerRuntime =
  | ({ kind: "runsc"; name: string } & RunscFeatures)
  /** The daemon's runc (or Podman's default runtime): kernel namespaces. */
  | { kind: "runc"; name?: string };

/** Read the runtime arguments Docker reports for a gVisor runtime. */
export function runscFeatures(runtimeArgs: readonly string[]): RunscFeatures {
  const flags = new Map<string, string>();
  for (let index = 0; index < runtimeArgs.length; index++) {
    const match = (runtimeArgs[index] ?? "").match(/^--?([a-z-]+)(?:=(.*))?$/);
    if (!match?.[1]) continue;
    const next = runtimeArgs[index + 1];
    const value =
      match[2] ?? (next !== undefined && !next.startsWith("-") ? next : "true");
    flags.set(match[1], value);
  }
  const hostUds = flags.get("host-uds") ?? "none";
  const netRaw = flags.get("net-raw") ?? "false";
  return {
    hostSockets: hostUds === "open" || hostUds === "all",
    netRaw: netRaw === "true" || netRaw === "1",
  };
}

/** What a Docker daemon offers the container backend. */
export type ContainerSupport =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** The daemon's gVisor runtime, when it has one. */
      runsc?: ContainerRuntime & { kind: "runsc" };
      /** The runc runtime's name, when the daemon names one (Docker does). */
      runc: { name?: string };
    };

/**
 * Whether a daemon answers, and which runtimes it has: a runtime named
 * `runsc`, or any whose binary is `runsc`, is gVisor.
 */
export async function probeContainerSupport(
  docker: DockerClient,
): Promise<ContainerSupport> {
  if ("socketPath" in docker.endpoint) {
    const socketPath = docker.endpoint.socketPath;
    try {
      fs.accessSync(socketPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      return {
        ok: false,
        reason:
          code === "EACCES"
            ? `This process may not use the Docker socket at ${socketPath}: run it in the socket's group (docker run --group-add)`
            : `No Docker socket at ${socketPath}`,
      };
    }
  }
  if (!(await docker.ping()))
    return {
      ok: false,
      reason: `No Docker daemon answers at ${describeEndpoint(docker)}`,
    };
  const info = await docker.info();
  return { ok: true, ...runtimesFromInfo(info) };
}

/** The runtimes `GET /info` lists, as the container backend uses them. */
export function runtimesFromInfo(info: Record<string, unknown>): {
  runsc?: ContainerRuntime & { kind: "runsc" };
  runc: { name?: string };
} {
  const runtimes =
    typeof info.Runtimes === "object" && info.Runtimes !== null
      ? Object.entries(info.Runtimes)
      : [];
  const runsc = runtimes.find(
    ([name, value]) =>
      name === "runsc" ||
      (typeof value === "object" &&
        value !== null &&
        path.basename(String(Reflect.get(value, "path") ?? "")) === "runsc"),
  );
  const args = (value: unknown): string[] => {
    const raw =
      typeof value === "object" && value !== null
        ? Reflect.get(value, "runtimeArgs")
        : undefined;
    return Array.isArray(raw) ? raw.map(String) : [];
  };
  return {
    ...(runsc
      ? {
          runsc: {
            kind: "runsc" as const,
            name: runsc[0],
            ...runscFeatures(args(runsc[1])),
          },
        }
      : {}),
    runc: runtimes.some(([name]) => name === "runc") ? { name: "runc" } : {},
  };
}

function describeEndpoint(docker: DockerClient): string {
  return "socketPath" in docker.endpoint
    ? docker.endpoint.socketPath
    : `tcp://${docker.endpoint.host}:${docker.endpoint.port}`;
}
