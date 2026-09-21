import { PGlite } from "@electric-sql/pglite";

const db = new PGlite(
  process.env.DESKTOP_DB ??
    (() => {
      throw new Error(
        "set DESKTOP_DB to the dev desktop PGlite directory (<data dir>/desktop/data/db)",
      );
    })(),
);
const pid =
  process.env.PROJECT_ID ??
  (() => {
    throw new Error("set PROJECT_ID to the demo project id");
  })();
const keep = [
  "Give me a launch checklist",
  "Turn Support answers.md",
  "Draft one short paragraph",
  "From the audience notes",
  "Read the launch plan",
];
const rows = await db.query(
  `select id, title from catamorphic.agent_sessions where project_id=$1`,
  [pid],
);
let n = 0;
for (const r of rows.rows) {
  if (keep.some((k) => (r.title ?? "").startsWith(k))) continue;
  await db.query(`delete from catamorphic.agent_sessions where id=$1`, [r.id]);
  n++;
}
const left = await db.query(
  `select title from catamorphic.agent_sessions where project_id=$1 order by created_at`,
  [pid],
);
console.log(
  "deleted",
  n,
  "remaining",
  left.rows.map((r) => (r.title ?? "").slice(0, 28)),
);
const apps = await db.query(
  `select name from catamorphic.apps where project_id=$1`,
  [pid],
);
console.log(
  "apps",
  apps.rows.map((r) => r.name),
);
await db.close();
