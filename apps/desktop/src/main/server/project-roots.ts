import fs from "node:fs/promises";
import path from "node:path";
import { discoverCheckout } from "@catamorphic/git";
import type { PGlite } from "@electric-sql/pglite";

/**
 * Desktop-owned mapping of projectId → user-visible folder. Lives in its own
 * `desktop` schema on the embedded PGlite, deliberately outside the shared
 * `catamorphic` schema: filesystem locations are a desktop concern, not part
 * of the embeddable product's data model.
 */
export class ProjectRootsStore {
  /**
   * In-memory mirror of the table, warmed at init and maintained by
   * set/delete. Exists for {@link getSync}: the coding-agent registry's
   * `get(id)` is synchronous (core contract) but project-agent resolution
   * needs the project's folder to read `agents/<slug>.json`.
   */
  private readonly cache = new Map<string, string>();
  private readonly automaticCheckpoints = new Set<string>();
  private registration = Promise.resolve();

  constructor(private readonly pglite: PGlite) {}

  async init(relocation?: { from: string; to: string }): Promise<void> {
    await this.pglite.exec(`
      CREATE SCHEMA IF NOT EXISTS desktop;
      CREATE TABLE IF NOT EXISTS desktop.project_roots (
        project_id uuid PRIMARY KEY,
        root_path  text NOT NULL
      );
    `);
    await this.pglite.exec(
      `ALTER TABLE desktop.project_roots ADD COLUMN IF NOT EXISTS automatic_checkpoints boolean NOT NULL DEFAULT false`,
    );
    if (relocation) {
      await this.pglite.query(
        "UPDATE desktop.project_roots SET root_path = $1 || substring(root_path FROM length($2) + 1) WHERE starts_with(root_path, $2 || '/')",
        [relocation.to, relocation.from],
      );
    }
    const rows = await this.pglite.query<{
      project_id: string;
      root_path: string;
      automatic_checkpoints: boolean;
    }>(
      "SELECT project_id, root_path, automatic_checkpoints FROM desktop.project_roots",
    );
    for (const row of rows.rows) {
      this.cache.set(row.project_id, row.root_path);
      if (row.automatic_checkpoints)
        this.automaticCheckpoints.add(row.project_id);
    }
  }

  checkpointsEnabled(projectId: string): boolean {
    return this.automaticCheckpoints.has(projectId);
  }

  /** Register before provisioning so every core consumer resolves the same checkout. */
  async register<T>(input: {
    rootPath: string;
    existing: boolean;
    automaticCheckpoints?: boolean;
    create(id: string, rootPath: string): Promise<T>;
    reopen(id: string): Promise<T>;
  }): Promise<T> {
    const previous = this.registration;
    let release = () => {};
    this.registration = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const checkout = input.existing
        ? await discoverCheckout({ path: input.rootPath })
        : null;
      const root = checkout?.path ?? path.resolve(input.rootPath);
      const canonical = await fs.realpath(root).catch(() => root);
      for (const [id, registered] of this.cache) {
        if (
          (await fs.realpath(registered).catch(() => registered)) === canonical
        )
          return input.reopen(id);
        if (checkout) {
          const other = await discoverCheckout({ path: registered }).catch(
            () => null,
          );
          if (other?.commonDirectory === checkout.commonDirectory)
            return input.reopen(id);
        }
      }
      if (!input.existing) {
        const entries = await fs.readdir(root).catch((error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return [];
          throw error;
        });
        if (entries.length > 0)
          throw new Error(
            "This folder already contains files. Open the existing folder or choose an empty location.",
          );
      }
      const id = crypto.randomUUID();
      await this.set(id, canonical);
      if (!input.existing && input.automaticCheckpoints !== false) {
        await this.pglite.query(
          "UPDATE desktop.project_roots SET automatic_checkpoints = true WHERE project_id = $1",
          [id],
        );
        this.automaticCheckpoints.add(id);
      }
      try {
        return await input.create(id, canonical);
      } catch (error) {
        await this.delete(id);
        throw error;
      }
    } finally {
      release();
    }
  }

  async get(projectId: string): Promise<string | null> {
    const result = await this.pglite.query<{ root_path: string }>(
      "SELECT root_path FROM desktop.project_roots WHERE project_id = $1",
      [projectId],
    );
    return result.rows[0]?.root_path ?? null;
  }

  /** Cached lookup for synchronous callers (complete once init() ran). */
  getSync(projectId: string): string | undefined {
    return this.cache.get(projectId);
  }

  async set(projectId: string, rootPath: string): Promise<void> {
    await this.pglite.query(
      `INSERT INTO desktop.project_roots (project_id, root_path)
       VALUES ($1, $2)
       ON CONFLICT (project_id) DO UPDATE SET root_path = EXCLUDED.root_path`,
      [projectId, rootPath],
    );
    this.cache.set(projectId, rootPath);
  }

  async delete(projectId: string): Promise<void> {
    await this.pglite.query(
      "DELETE FROM desktop.project_roots WHERE project_id = $1",
      [projectId],
    );
    this.cache.delete(projectId);
    this.automaticCheckpoints.delete(projectId);
  }
}
