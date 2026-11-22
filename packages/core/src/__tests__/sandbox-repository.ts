import type { SandboxProvider } from "@catamorphic/sandbox";

/**
 * A repository in a test's sandbox, with one commit of whatever the
 * checkout holds and that commit marked as saved: where a save starts from
 * when no session's copy seeded the sandbox.
 */
export async function initSandboxRepository(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  originUrl?: string;
}): Promise<void> {
  const agent = "-c user.name=Agent -c user.email=agent@example.test";
  const result = await input.provider.executeCommand(
    input.sandboxId,
    [
      "git init -q -b main",
      "git add -A",
      `git ${agent} commit -q --allow-empty -m baseline`,
      "git update-ref refs/work/synced HEAD",
      ...(input.originUrl
        ? [`git remote add origin '${input.originUrl}'`]
        : []),
    ].join(" && "),
    { cwd: input.projectDir },
  );
  if (result.exitCode !== 0)
    throw new Error(`Could not prepare the sandbox: ${result.result}`);
}
