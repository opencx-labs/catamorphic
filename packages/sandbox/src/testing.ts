/** A fixture keeps the original provider that owns its child handles. */
interface Owner {
  createSandbox(...options: never[]): Promise<{ id: string }>;
  destroySandbox(id: string): Promise<void>;
}

/** Attempt every teardown phase, preserving directories when one fails. */
export async function cleanupTestResources(
  steps: Array<() => unknown | Promise<unknown>>,
  remove?: () => unknown | Promise<unknown>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Test resource cleanup failed");
  await remove?.();
}

/** Original fixture providers retain the handles needed to stop their children. */
export class TestSandboxes {
  private readonly owners = new Map<Owner, Set<string>>();
  private readonly creating = new Set<Promise<unknown>>();

  record(provider: Owner, id: string): void {
    this.track(provider);
    this.owners.get(provider)?.add(id);
  }

  track<T extends Owner>(provider: T): T {
    if (this.owners.has(provider)) return provider;
    const ids = new Set<string>();
    this.owners.set(provider, ids);
    const create = provider.createSandbox.bind(provider);
    const destroy = provider.destroySandbox.bind(provider);
    provider.createSandbox = (...options) => {
      const pending = create(...options).then((sandbox) => {
        ids.add(sandbox.id);
        return sandbox;
      });
      this.creating.add(pending);
      void pending.then(
        () => this.creating.delete(pending),
        () => this.creating.delete(pending),
      );
      return pending;
    };
    provider.destroySandbox = async (id) => {
      await destroy(id);
      ids.delete(id);
    };
    return provider;
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    // Teardown can begin while a failed test still awaits allocation. Join
    // those creates before collecting IDs, retaining every original owner.
    while (this.creating.size) {
      const creating = await Promise.allSettled([...this.creating]);
      for (const result of creating)
        if (result.status === "rejected") errors.push(result.reason);
    }
    const results = await Promise.allSettled(
      [...this.owners].flatMap(([provider, ids]) =>
        [...ids].map((id) => provider.destroySandbox(id)),
      ),
    );
    for (const result of results)
      if (result.status === "rejected") errors.push(result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Test sandbox cleanup failed");
  }
}
