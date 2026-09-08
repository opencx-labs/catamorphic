# Agent context and capabilities

Read `AGENT-CAPABILITIES.md` and ADR 0103 in the installed source. Keep the existing
host identity and Environment/Allocation system.

1. Inspect the current user's verified identity, project/session, Allocation,
   agent-loop host, command target, and working directory. Do not infer placement
   from the agent's name or Git remote.
2. Configure optional display name/time zone through `agentCapabilities.currentUser`.
   Never inject a tenant directory, secrets, or permission arrays into prompts.
3. Register typed capabilities with live authorization. The stock host provides
   a member directory only under ordinary membership-management permission.
   Custom hosts decide their own directory and assignment visibility.
4. Verify discovery shows only matching permitted schemas and invocation repeats
   authorization. Use the existing `resolveMemberIdentity` hook for revocable
   member scope. Await existing approvals in `beforeInvoke` where required.
5. Pin running gateways to their Allocation. Remote headers carry scoped host
   credentials; the allocation header narrows a request but is not authentication.
6. Verify denial for another member/project, revocation after discovery, an
   Allocation move, cancellation, and sensitive-field filtering. Check both the
   actual harness and the HTTP/MCP transport it uses.

If a tool is missing, inspect host registration and permissions. If context is
wrong, inspect the authoritative Allocation and provider before editing prompts.
If an invocation is rejected after a move, stop the stale executor and use the
ordinary move/recovery flow. Never remove authorization or fall back to another
machine. For host-managed networking and updates, use the cluster reference.
