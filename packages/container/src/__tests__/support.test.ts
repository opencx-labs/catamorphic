import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DockerClient } from "../docker-client.js";
import { mountedPathOf, ownContainerId } from "../host-paths.js";
import {
  probeContainerSupport,
  runscFeatures,
  runtimesFromInfo,
} from "../support.js";

describe("runsc runtime arguments", () => {
  it("reads host sockets and raw sockets in either flag form", () => {
    expect(runscFeatures(["--host-uds=open", "--net-raw"])).toEqual({
      hostSockets: true,
      netRaw: true,
    });
    expect(runscFeatures(["--host-uds", "all", "--net-raw=true"])).toEqual({
      hostSockets: true,
      netRaw: true,
    });
    expect(runscFeatures(["-host-uds=create", "--net-raw=false"])).toEqual({
      hostSockets: false,
      netRaw: false,
    });
    expect(runscFeatures([])).toEqual({ hostSockets: false, netRaw: false });
  });

  it("finds gVisor by name or binary in /info", () => {
    expect(
      runtimesFromInfo({
        Runtimes: {
          runc: { path: "runc" },
          gvisor: {
            path: "/usr/local/bin/runsc",
            runtimeArgs: ["--host-uds=open"],
          },
        },
      }),
    ).toEqual({
      runsc: {
        kind: "runsc",
        name: "gvisor",
        hostSockets: true,
        netRaw: false,
      },
      runc: { name: "runc" },
    });
    expect(
      runtimesFromInfo({ Runtimes: { crun: { path: "/usr/bin/crun" } } }),
    ).toEqual({ runc: {} });
  });

  it("says when no daemon socket is there", async () => {
    const socketPath = path.join(os.tmpdir(), "work-no-docker", "docker.sock");
    expect(
      await probeContainerSupport(new DockerClient({ socketPath })),
    ).toEqual({ ok: false, reason: `No Docker socket at ${socketPath}` });
    expect(
      await probeContainerSupport(
        new DockerClient({ host: "127.0.0.1", port: 1 }),
      ),
    ).toEqual({
      ok: false,
      reason: "No Docker daemon answers at tcp://127.0.0.1:1",
    });
  });
});

describe("host paths", () => {
  it("finds the worker's own container from its mounts", () => {
    const id = "a".repeat(64);
    expect(
      ownContainerId(
        `651 640 254:1 /docker/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw\n`,
      ),
    ).toBe(id);
    expect(
      ownContainerId(
        `1 2 0:3 /containers/storage/overlay-containers/${id}/userdata/hosts /etc/hosts rw - tmpfs tmpfs rw\n`,
      ),
    ).toBe(id);
    expect(ownContainerId("22 1 8:1 / / rw - ext4 /dev/sda1 rw\n")).toBe(
      undefined,
    );
  });

  it("maps paths through the longest mount and refuses unmounted ones", () => {
    const hostPathOf = mountedPathOf([
      { source: "/srv/work/sign-ins", destination: "/data/sign-ins" },
      { source: "/srv/work", destination: "/data" },
    ]);
    expect(hostPathOf("/data/container/egress/x")).toBe(
      "/srv/work/container/egress/x",
    );
    expect(hostPathOf("/data/sign-ins/codex/m")).toBe(
      "/srv/work/sign-ins/codex/m",
    );
    expect(hostPathOf("/data")).toBe("/srv/work");
    expect(() => hostPathOf("/app/data")).toThrow("inside the worker's own");
  });
});
