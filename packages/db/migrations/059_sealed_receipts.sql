-- Receipts are sealed too (ADR 0207). The controller waiting for an
-- operation makes a key pair for its answer and keeps the private key in
-- memory; `reply_key` is the public key. The replica that receives the
-- receipt seals the response to it before writing, so a response (a
-- terminal's output, a downloaded file, a setup log) never reaches Postgres
-- in the clear. Operations queued before this change have no key; their
-- controllers already fail them as uncertain.
DELETE FROM remote_operations;

ALTER TABLE remote_operations
    ADD COLUMN reply_key text NOT NULL;
