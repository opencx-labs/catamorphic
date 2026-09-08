import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaytonaBackend } from "../storage-backend.js";

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
const EXTERNAL_INTEGRATIONS =
  process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1";

const describeIf =
  DAYTONA_API_KEY && EXTERNAL_INTEGRATIONS ? describe : describe.skip;

const TENANT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

describeIf("DaytonaBackend (integration)", () => {
  let backend: DaytonaBackend;

  beforeAll(() => {
    backend = new DaytonaBackend({ apiKey: DAYTONA_API_KEY });
  });

  afterAll(async () => {
    try {
      await backend.deleteProject(TENANT, PROJECT);
    } catch {
      // already cleaned up
    }
  }, 120_000);

  it("reports non-existent project as not existing", async () => {
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
  }, 10_000);

  it("initializes a project and marks it as existing", async () => {
    const repoPath = await backend.initProject(TENANT, PROJECT);
    expect(repoPath).toBe("project");
    expect(await backend.exists(TENANT, PROJECT)).toBe(true);
  }, 120_000);

  it("acquires a project and returns a repoPath", async () => {
    const { repoPath, release } = await backend.acquireProject(TENANT, PROJECT);
    expect(repoPath).toBe("project");
    expect(typeof release).toBe("function");
    await release();
  }, 60_000);

  it("returns sandboxId for an existing project", async () => {
    const sandboxId = backend.getSandboxId(TENANT, PROJECT);
    expect(sandboxId).toBeTruthy();
  }, 10_000);

  it("deletes a project and marks it as not existing", async () => {
    await backend.deleteProject(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
    expect(backend.getSandboxId(TENANT, PROJECT)).toBeUndefined();
  }, 60_000);
});
