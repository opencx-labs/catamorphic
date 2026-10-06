-- A project secret holds a shared value and one value per member (ADR
-- 0206). A row with no member is the shared value; each name has at most
-- one shared row and one row per member. `set_by` names who stored the
-- value (a person, or the identity a workflow run acted as).
ALTER TABLE project_secrets ADD COLUMN member_external_user_id text;
ALTER TABLE project_secrets ADD COLUMN set_by text;
ALTER TABLE project_secrets DROP CONSTRAINT project_secrets_pkey;
ALTER TABLE project_secrets
    ADD CONSTRAINT project_secrets_value_key
    UNIQUE NULLS NOT DISTINCT (project_id, name, member_external_user_id);
