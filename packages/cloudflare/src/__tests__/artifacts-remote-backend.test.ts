import nodeFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactsClient } from "../artifacts-client.js";
import { ArtifactsRemoteBackend } from "../artifacts-remote-backend.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const mainRef = "refs/heads/main";
const watcherRef = "refs/heads/catamorphic/watchers/fixture";
const sha = "a".repeat(40);
let cachePath: string;
let backend: ArtifactsRemoteBackend;
let remoteRefs: Map<string, string>;

beforeEach(async () => {
  cachePath = await mkdtemp(path.join(tmpdir(), "artifacts-mirror-test-"));
  const gitdir = path.join(cachePath, tenantId, `${projectId}.git`);
  await git.init({ fs: nodeFs, gitdir, bare: true, defaultBranch: "main" });
  for (const ref of [mainRef, watcherRef])
    await git.writeRef({ fs: nodeFs, gitdir, ref, value: sha });
  remoteRefs = new Map([
    [mainRef, sha],
    [watcherRef, sha],
  ]);
  const client = new ArtifactsClient({
    accountId: "fixture",
    apiToken: "fixture",
    namespace: "fixture",
  });
  vi.spyOn(client, "getRepo").mockResolvedValue({
    id: "fixture",
    name: "fixture",
    defaultBranch: "main",
    remote: "https://fixture.invalid/repo.git",
  });
  vi.spyOn(client, "createToken").mockResolvedValue({
    id: "fixture",
    plaintext: "fixture",
    scope: "write",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  vi.spyOn(git, "listServerRefs").mockImplementation(async () =>
    [...remoteRefs].map(([ref, oid]) => ({ ref, oid })),
  );
  vi.spyOn(git, "fetch").mockRejectedValue(
    new Error("Unexpected network fetch"),
  );
  vi.spyOn(git, "push").mockImplementation(async (input) => {
    if (input.delete && input.remoteRef) remoteRefs.delete(input.remoteRef);
    return { ok: true, error: null, refs: {} };
  });
  backend = new ArtifactsRemoteBackend({ client, cachePath });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(cachePath, { recursive: true, force: true });
});

it("does not resurrect a watcher ref deleted by another server", async () => {
  remoteRefs.delete(watcherRef);
  expect(
    await backend.withOrigin(tenantId, projectId, (origin) =>
      origin.resolveRef(watcherRef),
    ),
  ).toBeNull();
  expect(git.push).not.toHaveBeenCalled();
});

it("publishes watcher retirement once and preserves unrelated refs", async () => {
  await backend.withOrigin(tenantId, projectId, (origin) =>
    origin.deleteRef({ ref: watcherRef }),
  );
  expect(git.push).toHaveBeenCalledWith(
    expect.objectContaining({ delete: true, remoteRef: watcherRef }),
  );
  expect(
    await backend.withOrigin(tenantId, projectId, (origin) =>
      origin.resolveRef(watcherRef),
    ),
  ).toBeNull();
  expect(
    await backend.withOrigin(tenantId, projectId, (origin) =>
      origin.resolveRef(mainRef),
    ),
  ).toBe(sha);
  expect(git.push).toHaveBeenCalledTimes(1);
});

it("serializes mirror callbacks and discards unpublished refs after a failed callback", async () => {
  const entered = deferred();
  const release = deferred();
  const unpublishedRef = "refs/heads/unpublished";
  const first = backend.withOrigin(tenantId, projectId, async (origin) => {
    await origin.updateRef({ ref: unpublishedRef, sha });
    entered.resolve();
    await release.promise;
    throw new Error("Callback failed");
  });
  await entered.promise;
  let secondEntered = false;
  const second = backend.withOrigin(tenantId, projectId, async (origin) => {
    secondEntered = true;
    expect(await origin.resolveRef(unpublishedRef)).toBeNull();
  });
  const settled = Promise.allSettled([first, second]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);
  } finally {
    release.resolve();
  }
  expect((await settled).map((result) => result.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  expect(git.push).not.toHaveBeenCalled();
});

it("reports a rejected remote deletion instead of acknowledging retirement", async () => {
  vi.mocked(git.push).mockResolvedValueOnce({
    ok: true,
    error: null,
    refs: { [watcherRef]: { ok: false, error: "Deletion refused" } },
  });
  await expect(
    backend.withOrigin(tenantId, projectId, (origin) =>
      origin.deleteRef({ ref: watcherRef }),
    ),
  ).rejects.toThrow("Deletion refused");
  expect(remoteRefs.has(watcherRef)).toBe(true);
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
