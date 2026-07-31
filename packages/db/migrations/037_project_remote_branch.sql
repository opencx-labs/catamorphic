-- Branch on the linked external remote (e.g. a GitHub repo) that push-back
-- targets. The local history always lives on `main`; a repo imported from
-- GitHub may track a differently-named default branch (e.g. `master`).
-- GitHub credentials themselves are host-owned (GithubTokenStore) and never
-- stored in catamorphic's schema.
ALTER TABLE projects ADD COLUMN remote_branch varchar(255);
