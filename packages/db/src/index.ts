export { DEFAULT_SCHEMA } from "./config.js";
export type { CreateDatabaseOptions } from "./database.js";
export { createDatabase, DEFAULT_POOL_SIZE } from "./database.js";
export type { DB, Json, JsonObject, JsonValue } from "./generated/db.js";
export type {
  MigrateToLatestOptions,
  MigrateToLatestResult,
} from "./migrate.js";
export { migrateToLatest } from "./migrate.js";
export { getMigrationsDir } from "./migrations-dir.js";
