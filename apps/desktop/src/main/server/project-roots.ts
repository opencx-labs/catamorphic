import type { PGlite } from "@electric-sql/pglite";

/**
 * Desktop-owned mapping of projectId → user-visible folder. Lives in its own
 * `desktop` schema on the embedded PGlite, deliberately outside the shared
 * `catamorphic` schema: filesystem locations are a desktop concern, not part
 * of the embeddable product's data model.
 */
export class ProjectRootsStore {
  constructor(private readonly pglite: PGlite) {}

  async init(): Promise<void> {
    await this.pglite.exec(`
      CREATE SCHEMA IF NOT EXISTS desktop;
      CREATE TABLE IF NOT EXISTS desktop.project_roots (
        project_id uuid PRIMARY KEY,
        root_path  text NOT NULL
      );
    `);
  }

  async get(projectId: string): Promise<string | null> {
    const result = await this.pglite.query<{ root_path: string }>(
      "SELECT root_path FROM desktop.project_roots WHERE project_id = $1",
      [projectId],
    );
    return result.rows[0]?.root_path ?? null;
  }

  async set(projectId: string, rootPath: string): Promise<void> {
    await this.pglite.query(
      `INSERT INTO desktop.project_roots (project_id, root_path)
       VALUES ($1, $2)
       ON CONFLICT (project_id) DO UPDATE SET root_path = EXCLUDED.root_path`,
      [projectId, rootPath],
    );
  }

  async delete(projectId: string): Promise<void> {
    await this.pglite.query(
      "DELETE FROM desktop.project_roots WHERE project_id = $1",
      [projectId],
    );
  }
}
