import { volumeKey } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { PROJECT_PRINCIPAL_ID } from "../identity.js";
import {
  environmentSandboxVolumes,
  sandboxCapabilitiesFor,
} from "../services/execution-environments-service.js";
import {
  temporaryVolumesNote,
  volumeHoldNode,
} from "../services/volume-holds.js";

/* Volumes an Environment declares, as placement and sandboxes see them (ADR 0207). */

describe("Environment volumes", () => {
  const volumes = {
    pnpm: { path: "~/.local/share/pnpm/store" },
    docker: { path: "/var/lib/docker", exclusive: true, sizeMb: 20480 },
  };

  it("needs a machine that keeps volumes only when it declares some", () => {
    expect(sandboxCapabilitiesFor({ workloads: ["agent"], volumes })).toEqual([
      "volumes",
    ]);
    expect(sandboxCapabilitiesFor({ workloads: ["agent"] })).toEqual([]);
    expect(
      sandboxCapabilitiesFor({ workloads: ["agent"], volumes: {} }),
    ).toEqual([]);
  });

  it("keys each owner's copy by project, owner and name, in name order", () => {
    const ada = environmentSandboxVolumes({
      projectId: "project-1",
      owner: "ada",
      volumes,
    });
    expect(ada).toEqual([
      {
        name: "docker",
        key: volumeKey({
          projectId: "project-1",
          owner: "ada",
          name: "docker",
        }),
        path: "/var/lib/docker",
        exclusive: true,
        sizeMb: 20480,
      },
      {
        name: "pnpm",
        key: volumeKey({ projectId: "project-1", owner: "ada", name: "pnpm" }),
        path: "~/.local/share/pnpm/store",
      },
    ]);
    const keys = (owner: string | null, projectId = "project-1") =>
      environmentSandboxVolumes({ projectId, owner, volumes }).map(
        (volume) => volume.key,
      );
    expect(keys("ada")).toEqual(ada.map((volume) => volume.key));
    for (const other of [keys("bob"), keys(null), keys("ada", "project-2")])
      for (const key of other) expect(ada.map((v) => v.key)).not.toContain(key);
    expect(keys(null)).toContain(
      volumeKey({
        projectId: "project-1",
        owner: PROJECT_PRINCIPAL_ID,
        name: "pnpm",
      }),
    );
    expect(
      environmentSandboxVolumes({
        projectId: "project-1",
        owner: "ada",
        volumes: undefined,
      }),
    ).toEqual([]);
  });

  it("names the machine a hold is on", () => {
    expect(volumeHoldNode({ workerNodeId: "node-1", bindingId: "b" })).toBe(
      "node-1",
    );
    expect(
      volumeHoldNode({ workerNodeId: null, bindingId: "client:runner:lease" }),
    ).toBe("client:runner");
    expect(volumeHoldNode({ workerNodeId: null, bindingId: "local" })).toBe(
      "binding:local",
    );
  });

  it("tells the agent which volumes are empty and temporary", () => {
    expect(
      temporaryVolumesNote({
        volumes: [{ name: "docker", path: "/var/lib/docker" }],
        projectChat: false,
      }),
    ).toBe(
      "[Workspace] Another chat of yours on this machine holds the docker volume, so this workspace has an empty one at /var/lib/docker that goes away with it.",
    );
    expect(
      temporaryVolumesNote({
        volumes: [
          { name: "docker", path: "/var/lib/docker" },
          { name: "db", path: "~/.local/share/db" },
        ],
        projectChat: true,
      }),
    ).toBe(
      "[Workspace] Another of this project's chats on this machine holds the docker and db volumes, so this workspace has empty ones at /var/lib/docker, ~/.local/share/db that go away with it.",
    );
    expect(
      temporaryVolumesNote({ volumes: [], projectChat: false }),
    ).toBeUndefined();
  });
});
