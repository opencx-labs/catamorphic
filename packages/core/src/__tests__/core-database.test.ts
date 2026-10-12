import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * Core sends every parameter on whatever database a host injects as a value
 * Postgres stores (#159, #232). A database that never connects shows what a
 * query would send.
 */
describe("a host's database", () => {
  it("sends JSON values and text as Postgres stores them", () => {
    const core = new CatamorphicCore({
      db: new Kysely<DB>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (kysely) => new PostgresIntrospector(kysely),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      }),
      projectManager: {} as ProjectManager,
      environmentProvider: testEnvironmentProvider(),
    });
    const cut = "🚀".slice(0, 1);
    expect(
      core.db
        .updateTable("agent_items")
        .set({ payload: { text: `a${cut}` }, text: "b\u0000" })
        .where("id", "=", "item")
        .compile().parameters,
    ).toEqual(['{"text":"a\\ufffd"}', "b\uFFFD", "item"]);
  });
});
