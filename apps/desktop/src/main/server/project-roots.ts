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

  constructor(private readonly pglite: PGlite) {}

  async init(): Promise<void> {
    await this.pglite.exec(`
      CREATE SCHEMA IF NOT EXISTS desktop;
      CREATE TABLE IF NOT EXISTS desktop.project_roots (
        project_id uuid PRIMARY KEY,
        root_path  text NOT NULL
      );
    `);
    const rows = await this.pglite.query<{
      project_id: string;
      root_path: string;
    }>("SELECT project_id, root_path FROM desktop.project_roots");
    for (const row of rows.rows) this.cache.set(row.project_id, row.root_path);
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
  }
}
