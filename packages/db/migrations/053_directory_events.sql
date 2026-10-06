-- Directory events start workflows (ADR 0210): an account's transitions
-- (joined, left, groups changed) are recorded with it, so each is announced
-- once, in the transaction that records it.

-- When the account last became active: its first sign-in, or the sign-in
-- that re-enabled it. Null until it first signs in.
ALTER TABLE work_accounts ADD COLUMN joined_at timestamp with time zone;
-- Counts the account's transitions; directory events' external ids carry
-- it, so a replayed transition is stored once and a later one is new.
ALTER TABLE work_accounts ADD COLUMN lifecycle_revision integer DEFAULT 0 NOT NULL;
-- The groups the last directory answer was asked about. A group the server
-- starts or stops tracking is not a change in the member's groups.
ALTER TABLE work_accounts ADD COLUMN directory_tracked_groups jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Accounts the directory already answered for have signed in.
UPDATE work_accounts SET joined_at = directory_checked_at
    WHERE disabled_at IS NULL AND directory_checked_at IS NOT NULL;
