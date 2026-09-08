import { describe, expect, it } from "vitest";
import { probeRemoteConnection } from "./remote-connection-status.js";
import { RemoteAuthError } from "./remote-sync.js";

describe("probeRemoteConnection", () => {
  it("distinguishes healthy, removed access, sign-in, and network failure", async () => {
    await expect(
      probeRemoteConnection({
        remoteProjectId: "project-1",
        me: async () => ({ projects: [{ projectId: "project-1" }] }),
      }),
    ).resolves.toMatchObject({ state: "connected" });
    await expect(
      probeRemoteConnection({
        remoteProjectId: "project-1",
        me: async () => ({ projects: [] }),
      }),
    ).resolves.toMatchObject({ state: "access_removed" });
    await expect(
      probeRemoteConnection({
        remoteProjectId: "project-1",
        me: async () => {
          throw new RemoteAuthError("Reading your access");
        },
      }),
    ).resolves.toMatchObject({ state: "sign_in_required" });
    await expect(
      probeRemoteConnection({
        remoteProjectId: "project-1",
        me: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).resolves.toMatchObject({ state: "unreachable" });
  });
});
