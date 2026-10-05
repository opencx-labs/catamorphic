/**
 * Why a workflow may not bind a trigger kind that requires permissions
 * (ADR 0209), or undefined when it may. A kind whose events disclose what
 * only some members may read (directory events name people) requires the
 * workflow to declare those permissions, so turning it on asks for them
 * and its runs hold them only while the enabling member does (ADR 0158).
 * Shared by the host's deploy scan and each project's local check, so both
 * refuse the same bindings with the same words.
 */
export function triggerPermissionError(args: {
  kind: string;
  required: readonly string[] | undefined;
  declared: readonly string[];
}): string | undefined {
  const missing = (args.required ?? []).filter(
    (permission) => !args.declared.includes(permission),
  );
  if (missing.length === 0) return undefined;
  const list = missing.map((permission) => JSON.stringify(permission));
  return `'${args.kind}' events need ${missing.join(" and ")}: declare permissions: [${list.join(", ")}] in the workflow`;
}
