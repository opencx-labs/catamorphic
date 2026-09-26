-- Who created a project's linked network remote (ADR 0170). `attached`: the
-- repository existed before Work (an opened folder with an origin, a clone, an
-- imported company repository); Work only pushes `work/*` branches there and
-- shares everything else as pull requests. `owned`: Work created the
-- repository and ADR 0044 sync may update its tracked branch. Every linked
-- remote states its ownership; an unlinked project has none.
ALTER TABLE projects ADD COLUMN remote_ownership text;

UPDATE projects SET remote_ownership = 'attached' WHERE remote_url IS NOT NULL;

ALTER TABLE projects
    ADD CONSTRAINT projects_remote_ownership_check CHECK (
        remote_ownership = ANY (ARRAY['owned'::text, 'attached'::text])
    ),
    ADD CONSTRAINT projects_remote_ownership_linked_check CHECK (
        (remote_url IS NULL) = (remote_ownership IS NULL)
    );
