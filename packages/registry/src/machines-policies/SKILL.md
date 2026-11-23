---
name: machines-policies
description: Compose a Work machine plan using small policy functions.
---

# Plan your machines

Use `onePerPerson` for a list of users or the members of a project role.
Use `onDemand` to size and cap a pool of workers or `onePerChatKey` for a
dedicated worker per project chat. `stopWhenIdle` keeps disk while work is
quiet, and `destroyStoppedAfter` bounds retention. The Work server detects
loss and replaces a managed machine if your plan still names it. Use
`replaceNeverEnrolled` to limit how long an unconnected machine can stay
in the plan. Compose these policies with `compose` and exercise the result
through `@catamorphic/work-server/testing`.
