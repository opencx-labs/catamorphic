# 0012 — S3-compatible object storage as a git origin backend

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

ADR 0004 made Cloudflare Artifacts the target for canonical project code
storage, but Artifacts is in closed beta and our account has not been granted
access. `FsRemoteBackend` keeps origins on one server's disk, which blocks
stateless / horizontally scaled hosts. We need durable, host-agnostic origin
storage available today.

`git-sync` already performs **object-level transfer** against the `OriginRepo`
contract (`readObject` / `writeObject` / `hasObject` / `resolveRef` /
`updateRef` with an `expected` compare-and-swap). Git objects are immutable and
content-addressed, and S3-compatible stores (Cloudflare R2, AWS S3, MinIO) now
support conditional writes (`If-Match` / `If-None-Match`, `412` on conflict).
The contract therefore maps directly onto a bucket with no git repo on disk at
all.

## Decision

New vendor plugin package **`@catamorphic/s3`** (per ADR 0008) implementing
`RemoteBackend` + `OriginRepo` **directly against an S3-compatible bucket**:

- Layout per project under `<prefix>/<tenantId>/<projectId>/`:
  - `objects/<sha>` — git objects in wrapped form (`<type> <len>\0<content>`),
    so `sha1(body) == oid` and blobs are self-describing and verifiable.
  - `refs/heads/<branch>` — the 40-char commit SHA as the object body.
  - `repo.json` — existence marker written by `initRemote`.
- `updateRef` maps the contract's `expected` CAS onto conditional PUTs:
  `If-Match` with the ETag of the expected body (ETag = MD5 for simple PUTs),
  `If-None-Match: *` for ref creation. A `412` surfaces as the same
  "ref moved" error `FsOriginRepo` throws.
- No local mirror and no locking — unlike `ArtifactsRemoteBackend.withOrigin`,
  the origin is accessed directly; correctness comes from the ref CAS.
- The S3 client is isolated behind a small `ObjectStore` interface;
  `S3ObjectStore` (aws-sdk v3) is the real implementation and
  `InMemoryObjectStore` backs unit tests.
- `getCloneSource` is **not** implemented — buckets don't speak the git
  protocol, so sandboxes use the existing file-upload path (same as
  `FsRemoteBackend`).
- Hosts select this backend explicitly in boot code. `S3_*` variables are a
  possible host convention, not a library-level backend switch.

Alternatives considered: an fs-shim mirror synced to the bucket (rejected:
re-adds the mirror complexity for no benefit since no git client reads the
bucket) and whole-repo bundles/tarballs per push (rejected: full up/down
transfer per sync and a wide race window instead of per-ref CAS).

## Consequences

- Origins are durable and reachable from any server; hosts can treat dev
  working copies as ephemeral cache.
- Sandboxes always receive uploads instead of cloning until Artifacts access
  lands; swapping back is a one-line change in host boot code because both
  backends implement `RemoteBackend` (ADR 0004 remains the direction).
- Sync does one HTTP round trip per object; acceptable at our repo sizes, and
  a read-through cache is an easy later optimization since objects are
  immutable.
