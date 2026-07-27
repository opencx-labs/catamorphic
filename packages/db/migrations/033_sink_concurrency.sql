-- Record the sink's declared write concurrency on the batch execution state.
--
-- Sink chunks were written strictly serially because writeBatch threads a
-- state value from one chunk to the next. Sinks that carry no state (no
-- initialize, writeBatch returns no state) can declare `concurrency` and have
-- their chunks fanned out; the declaration is captured once at sink start so
-- the per-chunk scheduler does not re-inspect the module.
ALTER TABLE batch_execution_states
  ADD COLUMN sink_concurrency integer NOT NULL DEFAULT 1;

ALTER TABLE batch_execution_states
  ADD CONSTRAINT chk_batch_sink_concurrency CHECK (sink_concurrency >= 1);
