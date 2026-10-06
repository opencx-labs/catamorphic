-- Directory events waiting to reach their projects (ADR 0210). A
-- transition records its event here in the transaction that records the
-- transition; reaching the subscribed projects happens after it commits
-- and retries until it succeeds, so a failure there never undoes the
-- transition: a departed member stays disabled and signed out.
CREATE TABLE work_directory_announcements (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id text NOT NULL,
    -- The account and its lifecycle revision: one account's events reach
    -- projects in the order they happened, so a join that has to wait is
    -- never delivered after the departure that followed it.
    user_id text NOT NULL,
    revision integer NOT NULL,
    kind text NOT NULL,
    -- `<kind>:<user id>:<revision>`: one row per transition.
    external_id text NOT NULL UNIQUE,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_work_directory_announcements_due
    ON work_directory_announcements USING btree (next_attempt_at);
CREATE INDEX idx_work_directory_announcements_account
    ON work_directory_announcements USING btree (user_id, revision);
