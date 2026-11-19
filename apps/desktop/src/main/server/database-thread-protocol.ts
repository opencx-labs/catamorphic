/** One request to the database's thread, answered by its `id`. */
export type DatabaseRequest =
  | {
      id: number;
      type: "query";
      sql: string;
      params?: unknown[];
      rowMode?: "array" | "object";
      /** The open transaction the statement belongs to. */
      transaction?: number;
    }
  | { id: number; type: "exec"; sql: string; transaction?: number }
  | { id: number; type: "begin"; transaction: number }
  | { id: number; type: "commit"; transaction: number }
  | { id: number; type: "rollback"; transaction: number }
  | { id: number; type: "close" };

/** A database error as its fields: Postgres codes and constraints survive. */
export interface DatabaseFailure {
  name: string;
  message: string;
  stack?: string;
  fields: Record<string, unknown>;
}

export type DatabaseReply =
  | { type: "ready" }
  | { type: "failed"; error: DatabaseFailure }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; error: DatabaseFailure };
