// Child half of the crash-recovery test: opens the on-disk PGlite the parent
// prepared, claims the given execution job with a short lease (exactly the
// SQL shape ExecutionJobsService.claim produces), then commits writes in a
// loop until the parent SIGKILLs it mid-flight. Each committed write is
// announced on stdout, so the parent knows which rows must survive recovery.
import { PGlite } from "@electric-sql/pglite";

const [dataDir, jobId] = process.argv.slice(2);
if (!dataDir || !jobId) {
  console.error("usage: pglite-crash-writer.mjs <dataDir> <jobId>");
  process.exit(2);
}

const pglite = new PGlite(dataDir);

await pglite.query(
  `UPDATE catamorphic.execution_jobs
   SET status = 'running',
       leased_by = 'crash-worker',
       lease_token = '11111111-1111-4111-8111-111111111111',
       lease_generation = lease_generation + 1,
       heartbeat_at = clock_timestamp(),
       lease_expires_at = clock_timestamp() + interval '1 second',
       attempt = attempt + 1,
       updated_at = clock_timestamp()
   WHERE id = $1 AND status = 'pending'`,
  [jobId],
);
console.log("CLAIMED");

for (let tick = 1; ; tick += 1) {
  await pglite.query(`INSERT INTO catamorphic.tenants (name) VALUES ($1)`, [
    `tick-${tick}`,
  ]);
  // Only printed after the insert resolves, i.e. after PGlite has flushed
  // the write to the data dir — the parent asserts these rows survive.
  console.log(`TICK ${tick}`);
}
