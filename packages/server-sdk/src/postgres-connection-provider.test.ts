import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  query: vi.fn(),
  cancelQuery: vi.fn(),
  release: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {}
      async connect() {
        return { query: fake.query, release: fake.release };
      }
      async end() {}
      totalCount = 1;
    },
    Client: class {
      async connect() {}
      query = fake.cancelQuery;
      async end() {}
    },
  },
}));

import { definePostgresConnectionProvider } from "./postgres-connection-provider.js";

beforeEach(() => {
  fake.query.mockReset();
  fake.cancelQuery.mockReset();
  fake.release.mockReset();
});

describe("Postgres transaction-pool cancellation", () => {
  it("captures the backend pinned by BEGIN instead of the backend returned by an earlier statement", async () => {
    let inTransaction = false;
    let fetched = () => {};
    const ready = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    let rejectQuery: (error: Error) => void = () => {};
    const active = new Promise<never>((_resolve, reject) => {
      rejectQuery = reject;
    });
    const canceled: number[] = [];
    fake.query.mockImplementation(async (query: string) => {
      if (typeof query !== "string") return { rows: [] };
      if (query === "BEGIN TRANSACTION READ ONLY") inTransaction = true;
      if (query === "SELECT pg_backend_pid() AS pid") {
        // A transaction pooler releases backend 11 at the end of the
        // standalone statement and assigns backend 22 when BEGIN arrives.
        return { rows: [{ pid: inTransaction ? 22 : 11 }] };
      }
      if (query.startsWith("FETCH")) {
        fetched();
        return active;
      }
      return { rows: [] };
    });
    fake.cancelQuery.mockImplementation(
      async (_query: string, values: number[]) => {
        canceled.push(values[0] ?? -1);
        rejectQuery(new Error("query canceled"));
        return { rows: [{ pg_cancel_backend: true }] };
      },
    );
    const provider = definePostgresConnectionProvider({
      kind: "pooled",
      displayName: "Pooled",
    });
    const abort = new AbortController();
    const operation = provider.invoke({
      material: new TextEncoder().encode(
        JSON.stringify({ connectionString: "postgresql://fixture.invalid/db" }),
      ),
      connection: { id: "pooled", revision: 1 },
      action: "query",
      capabilities: ["query"],
      input: { sql: "SELECT 1", purpose: "Cancel a transaction-pool query" },
      signal: abort.signal,
    });
    const rejected = expect(operation).rejects.toThrow("query canceled");
    try {
      await ready;
      abort.abort();
      await rejected;
      expect(canceled).toEqual([22]);
      expect(canceled).not.toContain(11);
      await expect.poll(() => fake.release.mock.calls.length).toBe(1);
      expect(fake.release).toHaveBeenCalledWith(true);
    } finally {
      await provider.close();
    }
  });
});
