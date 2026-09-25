import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { definePostgresConnectionProvider } from "./postgres-connection-provider.js";

const databaseUrl = process.env.DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const schema = `gateway_${suffix}`;
const reader = `gateway_reader_${suffix}`;
const writer = `gateway_writer_${suffix}`;
const signaller = `gateway_signaller_${suffix}`;
const password = randomBytes(12).toString("hex");

function urlFor(role: string): string {
  const url = new URL(databaseUrl ?? "postgres://localhost/test");
  url.username = role;
  url.password = password;
  return url.toString();
}

async function authorize(
  provider: ReturnType<typeof definePostgresConnectionProvider>,
  connectionString: string,
) {
  const result = await provider.completeAuthorization?.({
    tenantId: "t",
    projectId: "p",
    externalUserId: "u",
    callback: { connectionString },
  });
  if (!result) throw new Error("no authorization result");
  return result.material;
}

describe.skipIf(!databaseUrl)("database gateway connections (ADR 0163)", () => {
  const admin = new pg.Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(
      `CREATE TABLE ${schema}.orders AS
         SELECT n AS id, (n % 7) AS customer, n * 10 AS cents
           FROM generate_series(1, 5000) AS n`,
    );
    await admin.query(`ANALYZE ${schema}.orders`);
    for (const role of [reader, writer, signaller]) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await admin.query(`GRANT SELECT ON ${schema}.orders TO ${role}`);
    }
    await admin.query(`GRANT INSERT ON ${schema}.orders TO ${writer}`);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP ROLE ${reader}`);
    await admin.query(`DROP ROLE ${writer}`);
    await admin.query(`DROP ROLE ${signaller}`);
    await admin.end();
  });

  it("accepts only credentials of a dedicated read-only role", async () => {
    const provider = definePostgresConnectionProvider({
      kind: "prod-db",
      displayName: "Production",
    });
    await expect(authorize(provider, databaseUrl ?? "")).rejects.toThrow(
      "dedicated read-only role",
    );
    await expect(authorize(provider, urlFor(writer))).rejects.toThrow(
      "can write tables",
    );
    // A role that could act outside the transaction is refused too.
    await admin.query(`GRANT pg_signal_backend TO ${signaller}`);
    await expect(authorize(provider, urlFor(signaller))).rejects.toThrow(
      "outside a transaction",
    );
    await expect(authorize(provider, urlFor(reader))).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it("returns bounded rows for one read statement", async () => {
    const provider = definePostgresConnectionProvider({
      kind: "prod-db",
      displayName: "Production",
      maxRows: 3,
    });
    const material = await authorize(provider, urlFor(reader));
    const result = await provider.invoke({
      material,
      action: "query",
      input: {
        sql: `SELECT id, cents FROM ${schema}.orders WHERE customer = $1 ORDER BY id`,
        params: [3],
        purpose: "test",
      },
      capabilities: ["query"],
    });
    expect(result).toMatchObject({
      columns: ["id", "cents"],
      rows: [
        { id: 3, cents: 30 },
        { id: 10, cents: 100 },
        { id: 17, cents: 170 },
      ],
      rowCount: 3,
      truncated: true,
    });
  });

  it("refuses writes, stacked statements, and plans above the cost ceiling", async () => {
    const provider = definePostgresConnectionProvider({
      kind: "prod-db",
      displayName: "Production",
      maxCost: 50,
      statementTimeoutMs: 300,
    });
    const material = await authorize(provider, urlFor(reader));
    const query = (sql: string) =>
      provider.invoke({
        material,
        action: "query",
        input: { sql, purpose: "test" },
        capabilities: ["query"],
      });
    await expect(query(`DELETE FROM ${schema}.orders`)).rejects.toThrow(
      "only one SELECT",
    );
    await expect(
      query(`SELECT 1; DELETE FROM ${schema}.orders`),
    ).rejects.toThrow("multiple commands");
    await expect(
      query(
        `WITH gone AS (DELETE FROM ${schema}.orders RETURNING id) SELECT * FROM gone`,
      ),
    ).rejects.toThrow();
    await expect(
      query(`SELECT * FROM ${schema}.orders ORDER BY cents DESC`),
    ).rejects.toThrow("exceeds 50");
    await expect(query("SELECT pg_sleep(2)")).rejects.toThrow(
      /statement timeout|canceling/,
    );
    // A row larger than the whole result budget never reaches memory.
    const small = definePostgresConnectionProvider({
      kind: "prod-db",
      displayName: "Production",
      maxResultBytes: 1_000,
    });
    const smallMaterial = await authorize(small, urlFor(reader));
    await expect(
      small.invoke({
        material: smallMaterial,
        action: "query",
        input: { sql: "SELECT repeat('x', 5000) AS big", purpose: "test" },
        capabilities: ["query"],
      }),
    ).rejects.toThrow("single row exceeds");
    const count = await admin.query(
      `SELECT count(*)::int AS n FROM ${schema}.orders`,
    );
    expect(count.rows[0]?.n).toBe(5000);
  });

  it("describes the tables the role may read", async () => {
    const provider = definePostgresConnectionProvider({
      kind: "prod-db",
      displayName: "Production",
    });
    const material = await authorize(provider, urlFor(reader));
    const described = await provider.invoke({
      material,
      action: "schema",
      input: { schema },
      capabilities: ["schema"],
    });
    expect(described).toEqual({
      tables: [
        {
          name: `${schema}.orders`,
          columns: [
            { name: "id", type: "integer" },
            { name: "customer", type: "integer" },
            { name: "cents", type: "integer" },
          ],
        },
      ],
    });
  });
});
