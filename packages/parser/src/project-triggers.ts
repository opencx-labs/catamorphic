import type {
  ProjectTriggerKind,
  ResolvedTriggerBinding,
  WorkflowTriggerBinding,
} from "./types.js";

/**
 * Resolves a binding through any chain of project trigger kinds (ADR 0171)
 * to the kind the host fires: the root kind and its config, every filter
 * along the way (all must match), and the project kind the binding named.
 * A kind no project kind defines is returned unchanged; whether the host
 * registers it is the host's check. Cycles and config on a project kind
 * (which accepts only `where`) are errors.
 */
export function resolveTriggerBinding(input: {
  binding: Pick<WorkflowTriggerBinding, "kind" | "config" | "where">;
  projectKinds: readonly ProjectTriggerKind[];
}):
  | { ok: true; binding: ResolvedTriggerBinding }
  | { ok: false; error: string } {
  const kinds = new Map(input.projectKinds.map((kind) => [kind.name, kind]));
  const where: unknown[] =
    input.binding.where === undefined ? [] : [input.binding.where];
  const chain: string[] = [];
  let current: { kind: string; config: unknown } = input.binding;
  for (
    let kind = kinds.get(current.kind);
    kind;
    kind = kinds.get(current.kind)
  ) {
    if (chain.includes(kind.name)) {
      return {
        ok: false,
        error: `Trigger kinds form a cycle: ${[...chain, kind.name].join(" -> ")}`,
      };
    }
    if (!isEmptyObject(current.config)) {
      return {
        ok: false,
        error: `Trigger kind '${kind.name}' is defined by the project and takes only 'where'`,
      };
    }
    chain.push(kind.name);
    if (kind.where !== undefined) where.push(kind.where);
    if (kind.from.where !== undefined) where.push(kind.from.where);
    current = kind.from;
  }
  return {
    ok: true,
    binding: {
      kind: current.kind,
      config: current.config,
      where,
      ...(chain[0] ? { projectKind: chain[0] } : {}),
    },
  };
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
