import { createHash } from "node:crypto";

export { privateWorkflowAddress } from "@catamorphic/work-customization";

/** A package gets its own member-state namespace, never the member's entire store. */
export function customizationStateKey({
  subject,
  key,
}: {
  subject: string;
  key: string;
}) {
  if (
    !key ||
    key.length > 200 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("State keys are relative names without parent traversal.");
  return `_work/packages/${createHash("sha256").update(subject).digest("hex")}/${key}`;
}

export function assertCustomizationRunAccess({
  workflows,
  workflowName,
  retained,
}: {
  workflows: readonly string[];
  workflowName: string;
  retained: {
    artifactId: string;
    revision: number;
    lifetime: "member" | "session";
  } | null;
}) {
  const address =
    retained?.lifetime === "member"
      ? `private:${retained.artifactId}:${retained.revision}`
      : workflowName;
  if (retained?.lifetime === "session" || !workflows.includes(address))
    throw new Error("This package cannot read that workflow run.");
}
