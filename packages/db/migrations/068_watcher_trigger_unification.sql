-- A Watcher is an enablement of ordinary workflow trigger bindings. The
-- binding projection at its pinned commit is the only subscription source.

ALTER TABLE watchers DROP COLUMN event_kinds;
