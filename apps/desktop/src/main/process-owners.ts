import type { RegisteredOwner } from "../shared/resources.js";

/**
 * Who the processes Work starts run for (ADR 0266): a terminal registers its
 * shell, a sidebar module its worker. Resources credits each process to its
 * nearest registered ancestor.
 */
const owners = new Map<number, RegisteredOwner>();

/** Credit `pid` (and what it starts) to `owner` until the returned call. */
export function registerProcessOwner(
  pid: number | undefined,
  owner: RegisteredOwner,
): () => void {
  if (!pid) return () => {};
  owners.set(pid, owner);
  return () => {
    if (owners.get(pid) === owner) owners.delete(pid);
  };
}

export function registeredProcessOwners(): ReadonlyMap<
  number,
  RegisteredOwner
> {
  return owners;
}
