-- Operations are sealed to their executor (ADR 0207). Each executor (an
-- enrolled worker's node, `node:<id>`, or a member's runner, `client:<id>`)
-- registers the X25519 public key the queue seals its operations to; the
-- private key never leaves its machine. A worker registers it when it
-- enrolls or rotates its credential, a member's runner each time it
-- connects. An executor with no key receives nothing.
CREATE TABLE executor_keys (
    executor text PRIMARY KEY,
    public_key text NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL
);

-- A queued row holds `{ "kind", "sealed" }`, never the operation itself.
-- Operations queued in the clear before this change are dropped; their
-- controllers already fail them as uncertain.
DELETE FROM remote_operations;

-- Worker credentials rotate (ADR 0207). `credential_issued_at` dates the
-- current credential. A rotation leaves the new credential pending, with the
-- public key the worker generated beside it, while the current one keeps
-- working: the first call made with the pending credential makes it current,
-- registers its key, and ends the old one. A rotation asked again before
-- then replaces the pending credential, so a lost answer never strands the
-- worker. The operator asks for a rotation with `rotation_requested_at`
-- (answered by a credential issued after it); a credential older than 30
-- days is due on its own.
ALTER TABLE work_workers
    ADD COLUMN credential_issued_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN pending_credential_hash text,
    ADD COLUMN pending_public_key text,
    ADD COLUMN pending_issued_at timestamp with time zone,
    ADD COLUMN rotation_requested_at timestamp with time zone;

UPDATE work_workers SET credential_issued_at = enrolled_at;
