ALTER TABLE batch_runs
  ADD COLUMN source_done boolean NOT NULL DEFAULT false,
  ADD COLUMN source_page_queued boolean NOT NULL DEFAULT false;
