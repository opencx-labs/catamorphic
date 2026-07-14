ALTER TABLE deployment_runtimes
  ADD COLUMN sandbox_id varchar(255);

UPDATE deployment_runtimes
SET sandbox_id = provider_id
WHERE sandbox_id IS NULL;

ALTER TABLE deployment_runtimes
  ALTER COLUMN sandbox_id SET NOT NULL;
