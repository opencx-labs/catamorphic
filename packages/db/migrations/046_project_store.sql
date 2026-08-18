-- The project store (ADR 0055): the `store/` subtree of a project's one path
-- namespace — data produced by using the program (customer notes, contracts,
-- generated decks, uploads), partitioned by audience through document refs,
-- changed without review, versioned per write, never deployed. Git holds
-- the program; this holds the rest.
--
-- One row per live path, one row per version (a linear history — no
-- branches). Text-like content is kept inline for grep and full-text search;
-- bytes ride inline too unless the host configured a blob backend, in
-- which case `blob_key` points at them. Every write is stamped with the
-- caller (`written_by` = the host's externalUserId).

CREATE TABLE store_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Full project-relative path, always under `store/`.
  path           text NOT NULL,
  version        integer NOT NULL,
  -- The path is deleted at this version (history stays; a later write
  -- revives it at version + 1).
  deleted        boolean NOT NULL DEFAULT false,
  content_type   text NOT NULL,
  size           bigint NOT NULL,
  -- UTF-8 text when the content is text-like and small enough to index.
  text_content   text,
  -- Raw bytes when no blob backend is configured (and content isn't text).
  bytes          bytea,
  -- Key in the host's blob backend, when one is configured.
  blob_key       text,
  written_by     text NOT NULL,
  written_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  search_vector  tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(text_content, ''))
  ) STORED,
  UNIQUE (project_id, path)
);

CREATE INDEX store_documents_prefix_idx
  ON store_documents (project_id, path text_pattern_ops);
CREATE INDEX store_documents_search_idx
  ON store_documents USING gin (search_vector);

CREATE TABLE store_document_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES store_documents(id) ON DELETE CASCADE,
  version        integer NOT NULL,
  -- A tombstone: the path was deleted at this version.
  deleted        boolean NOT NULL DEFAULT false,
  content_type   text NOT NULL,
  size           bigint NOT NULL,
  text_content   text,
  bytes          bytea,
  blob_key       text,
  written_by     text NOT NULL,
  written_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
