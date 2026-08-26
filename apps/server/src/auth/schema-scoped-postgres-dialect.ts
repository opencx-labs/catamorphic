import {
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Dialect,
  type Kysely,
  PostgresDialect,
  type SchemaMetadata,
  sql,
  type TableMetadata,
} from "kysely";
import type { Pool } from "pg";

/** PostgreSQL dialect whose metadata surface is limited to one host schema. */
export class SchemaScopedPostgresDialect implements Dialect {
  readonly base: PostgresDialect;
  readonly schema: string;

  constructor(options: { pool: Pool; schema: string }) {
    this.base = new PostgresDialect({ pool: options.pool });
    this.schema = options.schema;
  }

  createDriver() {
    return this.base.createDriver();
  }

  createQueryCompiler() {
    return this.base.createQueryCompiler();
  }

  createAdapter() {
    return this.base.createAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SchemaScopedPostgresIntrospector({ db, schema: this.schema });
  }
}

interface PostgresColumnMetadataRow {
  column: string;
  not_null: boolean;
  has_default: boolean;
  table: string;
  table_type: string;
  type: string;
  type_schema: string;
  column_description: string | null;
  auto_incrementing: string | null;
}

class SchemaScopedPostgresIntrospector implements DatabaseIntrospector {
  readonly db: Kysely<unknown>;
  readonly schema: string;

  constructor(options: { db: Kysely<unknown>; schema: string }) {
    this.db = options.db;
    this.schema = options.schema;
  }

  async getSchemas(): Promise<SchemaMetadata[]> {
    return [{ name: this.schema }];
  }

  async getTables(
    options: DatabaseMetadataOptions = { withInternalKyselyTables: false },
  ): Promise<TableMetadata[]> {
    // Kysely's stock Postgres introspector scans every schema. A concurrent
    // drop elsewhere in a shared database can invalidate pg_get_serial_sequence
    // halfway through that scan and abort an otherwise unrelated auth boot.
    const result = await sql<PostgresColumnMetadataRow>`
      SELECT
        a.attname AS column,
        a.attnotnull AS not_null,
        a.atthasdef AS has_default,
        c.relname AS table,
        c.relkind AS table_type,
        typ.typname AS type,
        dtns.nspname AS type_schema,
        col_description(a.attrelid, a.attnum) AS column_description,
        pg_get_serial_sequence(
          quote_ident(ns.nspname) || '.' || quote_ident(c.relname),
          a.attname
        ) AS auto_incrementing
      FROM pg_catalog.pg_attribute AS a
      INNER JOIN pg_catalog.pg_class AS c ON a.attrelid = c.oid
      INNER JOIN pg_catalog.pg_namespace AS ns ON c.relnamespace = ns.oid
      INNER JOIN pg_catalog.pg_type AS typ ON a.atttypid = typ.oid
      INNER JOIN pg_catalog.pg_namespace AS dtns ON typ.typnamespace = dtns.oid
      WHERE ns.nspname = ${this.schema}
        AND c.relkind IN ('r', 'v', 'p', 'f')
        AND a.attnum >= 0
        AND a.attisdropped != TRUE
      ORDER BY c.relname, a.attnum
    `.execute(this.db);
    const tables: TableMetadata[] = [];
    const tablesByName = new Map<string, TableMetadata>();

    for (const row of result.rows) {
      if (
        !options.withInternalKyselyTables &&
        (row.table === "kysely_migration" ||
          row.table === "kysely_migration_lock")
      ) {
        continue;
      }
      let table = tablesByName.get(row.table);
      if (!table) {
        table = {
          name: row.table,
          schema: this.schema,
          isForeign: row.table_type === "f",
          isView: row.table_type === "v",
          columns: [],
        };
        tablesByName.set(row.table, table);
        tables.push(table);
      }
      table.columns.push({
        name: row.column,
        dataType: row.type,
        dataTypeSchema: row.type_schema,
        isAutoIncrementing: row.auto_incrementing !== null,
        isNullable: !row.not_null,
        hasDefaultValue: row.has_default,
        comment: row.column_description ?? undefined,
      });
    }

    return tables;
  }
}
