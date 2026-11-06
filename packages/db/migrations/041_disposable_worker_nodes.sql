-- A disposable node's identity lasts one process (ADR 0190): a control-plane
-- replica on network Postgres registers a new node at every start. Once its
-- lease has lapsed past a grace period, or it released the lease on stop,
-- it never returns, so any replica recovers its work: workflow runs move to
-- a live node, chats are admitted again, and the node row is deleted.
ALTER TABLE worker_nodes ADD COLUMN disposable boolean NOT NULL DEFAULT false;
-- When recovery last looked at a lost node: each pass takes the nodes it
-- looked at longest ago, so nodes whose work cannot move yet never starve
-- newer ones.
ALTER TABLE worker_nodes ADD COLUMN recovery_attempted_at timestamptz;
