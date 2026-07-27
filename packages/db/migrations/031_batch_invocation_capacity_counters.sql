-- Keep member count and input bytes on the invocation row itself.
--
-- Admitting an item to a physical batch step re-read every member of every
-- open candidate to re-derive "how full is it", while holding the advisory
-- lock that serializes admission for that compatibility key. That made each
-- admission O(members) and the whole coalescing window O(members²) in member
-- payload bytes — all inside the serial section. The counters move the
-- capacity check into the candidate scan's WHERE clause, so admission does a
-- bounded index read no matter how large the batch has grown.
ALTER TABLE batch_step_invocations
  ADD COLUMN member_count integer NOT NULL DEFAULT 0,
  ADD COLUMN member_bytes bigint NOT NULL DEFAULT 0;

UPDATE batch_step_invocations
SET
  member_count = filled.member_count,
  member_bytes = filled.member_bytes
FROM (
  SELECT
    invocation_id,
    count(*) AS member_count,
    -- Serialized JSON text length, matching how the handler sizes inputs.
    COALESCE(sum(octet_length(input::text)), 0) AS member_bytes
  FROM batch_step_members
  GROUP BY invocation_id
) AS filled
WHERE batch_step_invocations.id = filled.invocation_id;
