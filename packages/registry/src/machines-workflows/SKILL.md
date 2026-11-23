---
name: machines-workflows
description: Run the infrastructure verbs through project-owned Work workflows.
---

# Manage machines from workflows

Use an administrator-only project and enable its infrastructure workflows
as the project owner. These runs carry a one-time worker enrollment code.
Keep their input and output out of logs.

Pass `workflowMachines` your authorized scoped SDK client, the project ID,
and the name and enablement ID for each verb. Optional `lifecycle` names
both the stop and start workflows. Bind their inputs to the corresponding
`MachinesHook` request and return its result at the final boundary. Each
run must issue idempotent infrastructure operations. Pass the enrollment
idempotency key directly to the cloud when creating a machine. When a
workflow answers pending, Work's next call can enroll the next attempt.
Keep these workflows on control-plane capacity so they can run even
when all worker machines are offline.
