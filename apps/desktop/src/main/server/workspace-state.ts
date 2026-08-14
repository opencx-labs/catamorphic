import type { PGlite } from "@electric-sql/pglite";

/**
 * Desktop-owned persistence of each project's open workspace — tabs,
 * chats, ordering, the reopen stack — so a relaunch lands where the user
 * left off. Lives in the `desktop` PGlite schema beside project_roots:
 * what's open is a desktop concern, not part of the embeddable product's
 * data model. The renderer owns the state's shape (it serializes only
 * what survives a restart); main stores it as opaque JSON.
 */
export class WorkspaceStateStore {
  constructor(private readonly pglite: PGlite) {}

  async init(): Promise<void> {
    await this.pglite.exec(`
      CREATE SCHEMA IF NOT EXISTS desktop;
      CREATE TABLE IF NOT EXISTS desktop.workspace_states (
        project_id uuid PRIMARY KEY,
        state      jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  async get(projectId: string): Promise<unknown | null> {
    const result = await this.pglite.query<{ state: unknown }>(
      "SELECT state FROM desktop.workspace_states WHERE project_id = $1",
      [projectId],
    );
    return result.rows[0]?.state ?? null;
  }

  async set(projectId: string, state: unknown): Promise<void> {
    await this.pglite.query(
      `INSERT INTO desktop.workspace_states (project_id, state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (project_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [projectId, JSON.stringify(state)],
    );
  }

  async delete(projectId: string): Promise<void> {
    await this.pglite.query(
      "DELETE FROM desktop.workspace_states WHERE project_id = $1",
      [projectId],
    );
  }
}
