import fs from "node:fs";
import path from "node:path";
import type { DockerClient } from "./docker-client.js";

/** Maps a path on this process's filesystem to the daemon's machine. */
export type HostPathOf = (localPath: string) => string;

/**
 * The id of the container this process runs in, read from the sources of
 * the `/etc/hostname` (and hosts, resolv.conf) bind mounts Docker and
 * Podman give every container. Undefined outside a container.
 */
export function ownContainerId(mountinfo: string): string | undefined {
  const match = mountinfo.match(
    /\/(?:containers|overlay-containers)\/([0-9a-f]{64})\/(?:userdata\/)?(?:hostname|hosts|resolv\.conf)\b/,
  );
  return match?.[1];
}

/**
 * How bind mount sources name this process's files on the daemon's
 * machine (ADR 0204). A worker running in a container that shares the
 * machine's daemon sees its data directory at the mount's destination;
 * the daemon needs the mount's source. Outside a container the paths are
 * the same.
 */
export async function hostPathResolver(args: {
  docker: DockerClient;
  /** `/proc/self/mountinfo`; read from the system by default. */
  mountinfo?: string;
}): Promise<HostPathOf> {
  const mountinfo =
    args.mountinfo ??
    (() => {
      try {
        return fs.readFileSync("/proc/self/mountinfo", "utf8");
      } catch {
        return "";
      }
    })();
  const id = ownContainerId(mountinfo);
  const inspected = id ? await args.docker.inspectContainer(id) : undefined;
  // Not in a container, or in one the daemon does not know (another daemon).
  if (!inspected) return (localPath) => path.resolve(localPath);
  const mounts = (Array.isArray(inspected.Mounts) ? inspected.Mounts : [])
    .flatMap((mount: unknown) => {
      if (typeof mount !== "object" || mount === null) return [];
      const source = Reflect.get(mount, "Source");
      const destination = Reflect.get(mount, "Destination");
      return typeof source === "string" &&
        source &&
        typeof destination === "string"
        ? [{ source, destination: destination.replace(/\/+$/, "") || "/" }]
        : [];
    })
    .sort((a, b) => b.destination.length - a.destination.length);
  return mountedPathOf(mounts);
}

/** Map through the longest mount destination containing the path. */
export function mountedPathOf(
  mounts: ReadonlyArray<{ source: string; destination: string }>,
): HostPathOf {
  return (localPath) => {
    const resolved = path.resolve(localPath);
    const mount = mounts.find(
      ({ destination }) =>
        resolved === destination ||
        resolved.startsWith(destination === "/" ? "/" : `${destination}/`),
    );
    if (!mount)
      throw new Error(
        `${resolved} is inside the worker's own container, so sandboxes cannot mount it. Mount the worker's data directory from the machine, at the same path.`,
      );
    return path.join(mount.source, path.relative(mount.destination, resolved));
  };
}
