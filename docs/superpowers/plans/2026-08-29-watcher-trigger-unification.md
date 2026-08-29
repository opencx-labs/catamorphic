# Watcher trigger unification implementation plan

1. Add tests proving Watcher source must contain a valid inline trigger,
   creation derives kinds from the pinned scan, and no event-kind input exists.
2. Generalize `TriggersService` to scan and fire a selected workflow at an
   explicit immutable commit and ref, while preserving the production firing
   API as the same underlying path.
3. Make `WatchersService` depend on `TriggersService`, remove its duplicate
   subscription state, and dispatch Project Events through the pinned trigger
   API.
4. Register normalized GitHub Project Event trigger kinds in the desktop and
   test their payload/config validation.
5. Remove `event_kinds` with a forward migration, regenerate database types,
   and rename the public list field to `triggerKinds`.
6. Update MCP tools, schemas, generated API types, React/UI consumers, docs,
   and focused tests without a compatibility layer.
7. Run focused tests while iterating, then the isolated root merge gate and
   review the complete diff. Do not commit or push without explicit approval.
