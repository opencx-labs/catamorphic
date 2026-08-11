-- Plain "use workflow" workflows and mutable-source test runs are removed:
-- every workflow is a defineWorkflow definition and every run executes a
-- deployed commit. The test/production mode split loses its meaning, so the
-- discriminator goes. Existing test-run rows are dev-only debris (greenfield)
-- and go with it.
DELETE FROM workflow_runs WHERE mode = 'test';

ALTER TABLE workflow_runs DROP COLUMN mode;
