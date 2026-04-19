export const DEFAULT_DATABASE_URL =
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";

export const DEFAULT_SCHEMA = "catamorphic";

export function resolveDatabaseUrl() {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function resolveSchema() {
  return process.env.CATAMORPHIC_DB_SCHEMA ?? DEFAULT_SCHEMA;
}

export function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
