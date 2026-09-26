import type {
  ConnectionActionDefinition,
  ConnectionProvider,
} from "@catamorphic/core";
import { ConnectionActionRefusedError } from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import pg from "pg";

export interface PostgresConnectionLimits {
  /** Rows returned to the caller; more rows mark the result truncated. */
  maxRows?: number;
  /** Serialized result budget in bytes. */
  maxResultBytes?: number;
  /** Planner total-cost ceiling; queries above it are refused unrun. */
  maxCost?: number;
  /** Planner row-estimate ceiling for the top plan node. */
  maxPlanRows?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export interface PostgresConnectionOptions extends PostgresConnectionLimits {
  kind: string;
  displayName: string;
  /** Test hook: a client factory in place of `new pg.Client`. */
  client?: (connectionString: string) => pg.Client;
}

const LIMITS = {
  maxRows: 500,
  maxResultBytes: 512 * 1024,
  maxCost: 100_000,
  maxPlanRows: 1_000_000,
  statementTimeoutMs: 10_000,
  lockTimeoutMs: 1_000,
} satisfies Required<PostgresConnectionLimits>;

/** Leading keywords of statements a cursor can read. */
const READ_STATEMENT = /^(select|with|values|table)\b/i;

/**
 * A production database reached through the gateway (ADR 0163). The
 * connection string of a dedicated read-only role lives in the vault; agents
 * and workflows call `query`, `explain`, and `schema`. The database enforces
 * the hard rules: one statement per call (extended protocol), a read-only
 * transaction, statement and lock timeouts, a cursor that fetches a bounded
 * number of rows, and a planner cost ceiling checked before execution.
 * Host guards (a model classifier, human approval) review the SQL first.
 */
export function definePostgresConnectionProvider(
  options: PostgresConnectionOptions,
): ConnectionProvider {
  const limits = { ...LIMITS, ...definedLimits(options) };
  const connect = async (material: Uint8Array) => {
    const { connectionString } = parseMaterial(material);
    const client =
      options.client?.(connectionString) ??
      new pg.Client({
        connectionString,
        connectionTimeoutMillis: 10_000,
        application_name: "work-gateway",
      });
    await client.connect();
    return client;
  };

  const actions: ConnectionActionDefinition[] = [
    {
      name: "query",
      description: `Run one read-only SQL statement on ${options.displayName}. Returns at most ${limits.maxRows} rows; queries whose plan exceeds the cost ceiling are refused, so filter and limit. State why you need the data in purpose.`,
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "One SELECT or WITH query" },
          params: { type: "array", description: "Values for $1, $2, ..." },
          purpose: {
            type: "string",
            description: "Why this data is needed; reviewers read it",
          },
        },
        required: ["sql", "purpose"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "explain",
      description: `Show the planner's estimate for one statement on ${options.displayName} without running it.`,
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" },
          params: { type: "array" },
        },
        required: ["sql"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "schema",
      description: `List the tables and columns this connection may read on ${options.displayName}.`,
      inputSchema: {
        type: "object",
        properties: { schema: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ];

  return {
    kind: options.kind,
    displayName: options.displayName,
    beginAuthorization: async () => ({
      challenge: {
        kind: "form",
        fields: [
          {
            name: "connectionString",
            label: "Read-only connection string",
            secret: true,
            required: true,
          },
        ],
      },
    }),
    completeAuthorization: async ({ callback }) => {
      const connectionString = callback.connectionString?.trim();
      if (!connectionString) {
        throw new Error("A connection string is required");
      }
      const material = new TextEncoder().encode(
        JSON.stringify({ connectionString }),
      );
      const client = await connect(material);
      try {
        await assertReadOnlyRole(client);
      } finally {
        await client.end();
      }
      return { material, capabilities: ["query", "explain", "schema"] };
    },
    listActions: async ({ capabilities }) =>
      actions.filter((action) => capabilities.includes(action.name)),
    invoke: async ({ material, action, input }) => {
      const request = parseInput(input);
      const client = await connect(material);
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query(
          `SET LOCAL statement_timeout = ${limits.statementTimeoutMs}`,
        );
        await client.query(`SET LOCAL lock_timeout = ${limits.lockTimeoutMs}`);
        if (action === "schema") return await listSchema(client, request);
        if (action !== "query" && action !== "explain") {
          throw new Error(`Unknown action '${action}'`);
        }
        const sql = requireReadStatement(request.sql);
        const plan = await explain(client, sql, request.params);
        if (action === "explain") return plan;
        if (plan.totalCost > limits.maxCost) {
          throw new ConnectionActionRefusedError(
            `Refused: estimated cost ${Math.round(plan.totalCost)} exceeds ${limits.maxCost}. Filter on indexed columns or aggregate.`,
          );
        }
        if (plan.planRows > limits.maxPlanRows) {
          throw new ConnectionActionRefusedError(
            `Refused: the plan estimates ${plan.planRows} rows, above ${limits.maxPlanRows}. Add filters or a LIMIT.`,
          );
        }
        return await runCursor(client, sql, request.params, limits, plan);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await client.end().catch(() => {});
      }
    },
  };
}

function definedLimits(
  options: PostgresConnectionLimits,
): PostgresConnectionLimits {
  return Object.fromEntries(
    Object.entries({
      maxRows: options.maxRows,
      maxResultBytes: options.maxResultBytes,
      maxCost: options.maxCost,
      maxPlanRows: options.maxPlanRows,
      statementTimeoutMs: options.statementTimeoutMs,
      lockTimeoutMs: options.lockTimeoutMs,
    }).filter(([, value]) => value !== undefined),
  );
}

function parseMaterial(material: Uint8Array): { connectionString: string } {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(material));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "connectionString" in parsed &&
    typeof parsed.connectionString === "string"
  ) {
    return { connectionString: parsed.connectionString };
  }
  throw new Error("Stored database credential is malformed");
}

function parseInput(input: Json): {
  sql: string;
  params: Json[];
  schema?: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Input must be an object");
  }
  const params = input.params ?? [];
  if (!Array.isArray(params)) throw new Error("params must be an array");
  return {
    sql: typeof input.sql === "string" ? input.sql : "",
    params,
    ...(typeof input.schema === "string" ? { schema: input.schema } : {}),
  };
}

/**
 * A readable early refusal for non-read statements. Not the boundary: the
 * read-only transaction and the role's grants are.
 */
function requireReadStatement(sql: string): string {
  const trimmed = sql
    .replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()+/, "")
    .replace(/;\s*$/, "");
  if (!READ_STATEMENT.test(trimmed)) {
    throw new ConnectionActionRefusedError(
      "Refused: only one SELECT, WITH, VALUES, or TABLE statement per call",
    );
  }
  return sql.replace(/;\s*$/, "");
}

async function explain(
  client: pg.Client,
  sql: string,
  params: Json[],
): Promise<{ totalCost: number; planRows: number; plan: Json }> {
  const result = await extendedQuery(
    client,
    `EXPLAIN (FORMAT JSON) ${sql}`,
    params,
  );
  const first: unknown = result.rows[0]?.["QUERY PLAN"];
  const top = Array.isArray(first) ? first[0] : undefined;
  const plan =
    typeof top === "object" && top !== null && "Plan" in top
      ? top.Plan
      : undefined;
  const fields = new Map<string, unknown>(
    typeof plan === "object" && plan !== null ? Object.entries(plan) : [],
  );
  const numeric = (key: string) => {
    const value = fields.get(key);
    return typeof value === "number" ? value : 0;
  };
  return {
    totalCost: numeric("Total Cost"),
    planRows: numeric("Plan Rows"),
    plan: JSON.parse(JSON.stringify(first ?? null)),
  };
}

async function runCursor(
  client: pg.Client,
  sql: string,
  params: Json[],
  limits: Required<PostgresConnectionLimits>,
  plan: { totalCost: number; planRows: number },
) {
  const started = Date.now();
  // DECLARE accepts only a query, so writes cannot hide in the cursor, and
  // the extended protocol rejects a second statement. A row larger than the
  // whole result budget fails in the database, before it reaches memory.
  await extendedQuery(
    client,
    `DECLARE work_gateway_cursor NO SCROLL CURSOR FOR
       SELECT work_gateway_row.* FROM (${sql}) AS work_gateway_row
        WHERE 1 / (CASE WHEN octet_length(work_gateway_row::text) > ${limits.maxResultBytes} THEN 0 ELSE 1 END) = 1`,
    params,
  ).catch((error: unknown) => {
    throw rowTooLarge(error) ?? error;
  });
  const rows: Json[] = [];
  let bytes = 0;
  let truncated = false;
  let fields: pg.FieldDef[] = [];
  // Small batches: stop reading as soon as the byte or row budget is spent.
  while (rows.length < limits.maxRows && !truncated) {
    const batch = await client
      .query(
        `FETCH FORWARD ${Math.min(50, limits.maxRows + 1 - rows.length)} FROM work_gateway_cursor`,
      )
      .catch((error: unknown) => {
        throw rowTooLarge(error) ?? error;
      });
    fields = batch.fields;
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        break;
      }
      const value: Json = JSON.parse(
        JSON.stringify(row, (_key, entry: unknown) =>
          typeof entry === "bigint" ? entry.toString() : entry,
        ),
      );
      bytes += JSON.stringify(value).length;
      if (bytes > limits.maxResultBytes) {
        truncated = true;
        break;
      }
      rows.push(value);
    }
  }
  if (rows.length >= limits.maxRows && !truncated) {
    const more = await client.query("FETCH FORWARD 1 FROM work_gateway_cursor");
    truncated = more.rows.length > 0;
  }
  const fetched = { fields };
  return {
    columns: fetched.fields.map((field) => field.name),
    rows,
    rowCount: rows.length,
    truncated,
    elapsedMs: Date.now() - started,
    estimate: { totalCost: plan.totalCost, planRows: plan.planRows },
  };
}

async function listSchema(client: pg.Client, request: { schema?: string }) {
  const result = await extendedQuery(
    client,
    `SELECT table_schema, table_name, column_name, data_type
             FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              AND ($1::text IS NULL OR table_schema = $1)
              AND has_table_privilege(quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT')
            ORDER BY table_schema, table_name, ordinal_position
            LIMIT 2000`,
    [request.schema ?? null],
  );
  const tables = new Map<string, Array<{ name: string; type: string }>>();
  for (const row of result.rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    const columns = tables.get(key) ?? [];
    columns.push({
      name: String(row.column_name),
      type: String(row.data_type),
    });
    tables.set(key, columns);
  }
  return {
    tables: [...tables.entries()].map(([name, columns]) => ({ name, columns })),
  };
}

/**
 * Refuse credentials that could write: superusers, table owners, and roles
 * holding any write privilege. The read-only transaction is a second wall.
 */
async function assertReadOnlyRole(client: pg.Client): Promise<void> {
  const role = await client.query(
    `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
  );
  const flags = role.rows[0];
  if (
    flags?.rolsuper ||
    flags?.rolcreaterole ||
    flags?.rolcreatedb ||
    flags?.rolbypassrls
  ) {
    throw new Error(
      "Use a dedicated read-only role: this one is a superuser or can create roles, databases, or bypass row security",
    );
  }
  // Effective privileges, inherited ones included: ownership through any
  // role this one belongs to, any write privilege on any table, and the
  // predefined roles that act outside a transaction.
  const writes = await client.query(
    `SELECT
       (SELECT count(*) FROM pg_class c
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND c.relnamespace NOT IN (
             SELECT oid FROM pg_namespace
              WHERE nspname IN ('pg_catalog', 'information_schema')
                 OR nspname LIKE 'pg_toast%')
           AND (pg_has_role(current_user, c.relowner, 'USAGE')
             OR has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')))::int AS writable,
       (SELECT count(*) FROM pg_roles r
         WHERE r.rolname IN ('pg_write_all_data', 'pg_signal_backend',
                             'pg_read_server_files', 'pg_write_server_files',
                             'pg_execute_server_program')
           AND pg_has_role(current_user, r.oid, 'USAGE'))::int AS dangerous`,
  );
  const counts = writes.rows[0];
  if ((counts?.writable ?? 0) > 0 || (counts?.dangerous ?? 0) > 0) {
    throw new Error(
      "Use a dedicated read-only role: this one owns or can write tables, or belongs to a role that acts outside a transaction",
    );
  }
}

/** The database's refusal of a row larger than the result budget. */
function rowTooLarge(error: unknown): Error | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "22012"
    ? new ConnectionActionRefusedError(
        "Refused: a single row exceeds the result budget. Select fewer or smaller columns.",
      )
    : undefined;
}

/**
 * The extended query protocol parses exactly one statement, so a second
 * statement smuggled into `sql` fails instead of running.
 */
function extendedQuery(client: pg.Client, text: string, values: unknown[]) {
  const config: pg.QueryConfig & { queryMode: "extended" } = {
    text,
    values,
    queryMode: "extended",
  };
  return client.query(config);
}
