/**
 * What `sync_project` tells the agent about a remote sync outcome. Sync only
 * pushes to repositories Work created; in an attached repository (ADR 0170)
 * local commits stay local until they are shared as a pull request, and the
 * agent must hear that instead of reaching for a raw push.
 */
export function syncReport(outcome: {
  status: string;
  rescueBranch?: string;
}): { status: string; rescueBranch?: string; note?: string } {
  switch (outcome.status) {
    case "no-remote":
      return {
        status: outcome.status,
        note: "This project is not linked to a remote repository, so there is nothing to sync.",
      };
    case "ahead":
      return {
        status: outcome.status,
        note: "This checkout has commits the shared repository does not. Work never pushes them to a repository it did not create. To share them, call create_pull_request; never push with git directly.",
      };
    case "diverged":
      return outcome.rescueBranch
        ? {
            status: outcome.status,
            rescueBranch: outcome.rescueBranch,
            note: `The histories conflict, so the local commits were saved to the branch ${outcome.rescueBranch} for review. The working tree is unchanged.`,
          }
        : {
            status: outcome.status,
            note: "The remote branch moved and this checkout has its own commits. Nothing was merged or pushed. Share the local commits with create_pull_request, and integrate the remote changes only when the user asks.",
          };
    case "deferred":
      return {
        status: outcome.status,
        note: "The remote has new commits, but the working tree has uncommitted edits, so nothing was changed. Sync again once the edits are committed.",
      };
    default:
      return { status: outcome.status };
  }
}
