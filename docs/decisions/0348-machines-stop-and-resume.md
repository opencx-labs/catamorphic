# 0348 Machines stop and resume; installation is a recipe

- **Status:** Accepted
- **Date:** 2026-11-20
- **Amends:** 0100, 0173, 0204, and 0205.

## Context

A machine can keep useful state on disk while it is idle. Work also needs
to drive worker processes on infrastructure with different image and
installation setups.

## Decision

When a plan wants a machine stopped, Work takes it out of placement under
the node lock once its workspaces and capacity holds have been released.
Stopping retains the disk, credential, sign-ins and worker identity. A
stopped worker contributes no available capacity. When the plan wants it
running, Work requests a start and waits for its worker to reconnect under
a new epoch. An infrastructure reply that the machine is gone goes
through loss recovery. Listings and chat wait status show the transition.

The server owns the worker protocol and enrollment. The host supplies
software installation, image selection and its own user data. The registry
offers stock and baked image recipes with an optional install-script route.

## Consequences

A host can keep stateful workers for bursts of work without keeping them
running. Hosts that omit stop and start still support creating and
destroying workers. Hand-enrolled workers stay under their operator's
control.
