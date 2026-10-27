import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  createDatabase,
  type DB,
  migrateToLatest,
  withStorableParameters,
} from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  Kysely,
  type KyselyPlugin,
  PGliteDialect,
  sql,
  WithSchemaPlugin,
} from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { DocumentsService } from "../services/documents-service.js";

const schema = `document_cancellation_${randomUUID().replaceAll("-", "")}`;
const connectionString = process.env.DATABASE_URL;
const databases: Array<[string, () => Kysely<DB>]> = [
  [
    "PGlite",
    () =>
      withStorableParameters(
        new Kysely<DB>({
          dialect: new PGliteDialect({
            pglite: new PGlite({ extensions: { pgcrypto } }),
          }),
          plugins: [new WithSchemaPlugin(schema)],
        }),
      ),
  ],
];
if (connectionString)
  databases.push([
    "Postgres",
    () => createDatabase({ connectionString, schema, poolSize: 4 }),
  ]);

describe.each(databases)(
  "canceled remote document writes on %s",
  (backend, open) => {
    const db = open();
    const identity: Identity = {
      tenantId: randomUUID(),
      externalUserId: "writer",
    };
    const projectId = randomUUID();
    // With no host local-root resolver, documents live on the server and
    // localPath returns null, as for object-backed remote projects.
    const projectManager = new ProjectManager(
      new FsBackend(path.join(os.tmpdir(), `unused-documents-${randomUUID()}`)),
    );
    const documents = new DocumentsService(db, { projectManager });

    beforeAll(async () => {
      await migrateToLatest({ db, schema });
      await db
        .insertInto("tenants")
        .values({ id: identity.tenantId, name: "Documents" })
        .execute();
      await db
        .insertInto("projects")
        .values({
          id: projectId,
          tenant_id: identity.tenantId,
          name: "Remote documents",
        })
        .execute();
      expect(
        await projectManager.localPath({
          tenantId: identity.tenantId,
          projectId,
        }),
      ).toBeNull();
    });

    afterAll(async () => {
      if (backend === "Postgres")
        await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    });

    it.each(["write", "delete"] as const)(
      "rolls back %s and its history when aborted after an awaited database write",
      async (operation) => {
        for (const stage of ["version insert", "document update"] as const) {
          const documentPath = `store/${operation}-${stage.replaceAll(" ", "-")}.md`;
          await documents.write({
            identity,
            projectId,
            path: documentPath,
            content: "Original",
            ifVersion: 0,
          });
          const before = await documents.read({
            identity,
            projectId,
            path: documentPath,
          });
          const history = await documents.history({
            identity,
            projectId,
            path: documentPath,
          });
          const held = new Set<object>();
          let entered = () => {};
          const ready = new Promise<void>((resolve) => {
            entered = resolve;
          });
          let release = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const plugin: KyselyPlugin = {
            transformQuery(args) {
              if (
                (stage === "version insert" &&
                  args.node.kind === "InsertQueryNode" &&
                  JSON.stringify(args.node).includes(
                    '"store_document_versions"',
                  )) ||
                (stage === "document update" &&
                  args.node.kind === "UpdateQueryNode" &&
                  JSON.stringify(args.node).includes('"store_documents"'))
              )
                held.add(args.queryId);
              return args.node;
            },
            async transformResult(args) {
              if (held.delete(args.queryId)) {
                entered();
                await gate;
              }
              return args.result;
            },
          };
          const gated = new DocumentsService(db.withPlugin(plugin), {
            projectManager,
          });
          const abort = new AbortController();
          const input = {
            identity,
            projectId,
            path: documentPath,
            ifVersion: 1,
            signal: abort.signal,
          };
          const pending =
            operation === "write"
              ? gated.write({ ...input, content: "Must not persist" })
              : gated.delete(input);
          const rejected = expect(pending).rejects.toThrow("document canceled");
          try {
            await ready;
            abort.abort(new Error("document canceled"));
            release();
            await rejected;
            expect(
              await documents.read({ identity, projectId, path: documentPath }),
            ).toEqual(before);
            expect(
              await documents.history({
                identity,
                projectId,
                path: documentPath,
              }),
            ).toEqual(history);
          } finally {
            release();
          }
        }
      },
    );
  },
);
