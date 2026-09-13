# Device-local output from a company agent

Proposed design, awaiting approval. 2026-09-13.

## Observed problem

The company agent runs on the server. A file written into its home directory
is not on the member's device. The manual CSM test reproduced that mistake.
Updated guidance now returns the content in chat and says it has not been saved.
That is accurate, but does not fulfill the desired file-creation experience.

## Proposed interaction

A member asks, "Create a renewal prep note." The company agent uses a narrowly
scoped desktop file capability. The desktop writes a new file into the existing
profile-local personal namespace and opens it. Its top status reads "Saved on
this device" and "Local only", with the actual path and Show in Finder. The
member needs no local AI account, GitHub account, or execution-environment choice.
Publish and Propose remain explicit actions on that same file.

## Boundary

Expose the capability only while an authenticated initiating desktop is attached
to the session. Route it through the host capability registry and a desktop
request/response bridge. The host must bind the request to the session's member,
project, profile and initiating device; an agent cannot choose another recipient.
Accept a filename and content, never an arbitrary filesystem path. Resolve paths
inside the existing personal namespace, reject traversal and symlinks, preserve
existing files unless an explicit edit identifies them, and bound transfer size.
Return a successful save only after the desktop confirms the write. If the
device disconnects, fail visibly and keep the content available in chat; do not
silently use shared project storage. Additional binary/large-file support can
extend the same operation rather than introduce another file entity.

This adds a device delivery bridge, not a draft, publishing queue, worktree, or
second file model. It does not make a company-hosted conversation private from
its server operator. Only the resulting saved file is excluded from project sync.

## Why this needs a decision

The existing this-machine execution option moves agent execution and requires
an available device runner. It does not let the already-running company agent
write a document to the member's device without that setup. A new bridge must
be an explicit host-injectable contract, rather than parsing filenames or hidden
commands from arbitrary chat Markdown. On approval, record that contract in an
ADR before implementing it.
