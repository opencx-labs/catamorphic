---
name: machines-ec2
title: Machines on EC2
description: How this project creates and destroys its Work server's machines on Amazon EC2 through a workflow machine class, with the IAM policy it needs, the class and rule setup for a review pool, disk sizing and replacing a machine short of disk, and what to check when a machine does not come up. Use when changing the EC2 workflows, their options, or the machines they make.
---

# Machines on EC2

The Work server's reconciler decides when a machine is needed and when it
goes (machine rules, machines on demand, replacing a lost machine,
draining before destroying it). This project only says how a machine is
made and removed on EC2, in `.work/workflows/src/machines-ec2.ts`,
installed from the `machines-ec2` pack and the team's to change. A
`workflow` class in the server's `WORK_MACHINES_CONFIG` names this project
and the two workflows; Work starts them through their project automations.
Use `writing-workflows` for workflow shape.

Keep this project to administrators: each create run's input holds the
machine's one-time enrollment code until it is used or expires.

## .work/workflows/src/machines-ec2.ts

`createMachine` binds `machine.create`. Work starts it once per
enrollment and reads its answer on a later pass. It calls `RunInstances`
with:

- `ClientToken`: the enrollment's `idempotencyKey` (64 hex characters,
  EC2's limit). A retried step, or a retried run, gets the same instance
  back instead of a second one. Never derive it from the name: a later
  machine of the rule reuses the name.
- `UserData`: the enrollment's `cloudInit`, base64. It installs Docker,
  gVisor where needed, and the Work worker with the enrollment code, the
  same cloud-init a Hetzner machine gets; the machine enrolls itself.
- IMDSv2 required with one hop, so sandboxes on the machine cannot reach
  its metadata or any role it has.
- Tags `work-machine` (the name), `work-rule`, `work-class`, `Name`, and
  the class's `tags`, on the instance and its volumes.

It answers `{ ref: "<instance id>" }`, or `{ refused }` when EC2 launched
nothing and would refuse again (an invalid parameter, missing
permissions, no capacity, a limit reached): Work then withdraws the code
and tries a new one on a later pass. Throttling and server errors fail the
run instead. Work treats that as uncertain: the machine may still come up
and enroll, and if it does not within the rule's `enrollMinutes` Work
destroys it by name.

`destroyMachine` binds `machine.destroy`. It looks the instance up by its
id and by the ClientToken it was launched with (Work passes the
enrollment's `idempotencyKey`), so a launch whose answer was lost is found
too, even after the class's tags or name changed, terminates what is
still alive, and answers `{ done: true }` only once nothing is left. EC2
can take a while to list a new instance, so for ten minutes after the
latest moment a launch can have been made (`requestedAt`: Work sends when
the create run ended, even one it canceled as stuck) nothing found still
answers `{ done: false }`, and without that time it never answers done.
Until done, Work runs it again on later passes.

The class's `options`, as the workflows read them:

| Option | Meaning |
|--------|---------|
| `region` | The AWS region, such as `eu-west-1` |
| `instanceType` | Such as `r7i.2xlarge`; must be known to the installed `@aws-sdk/client-ec2` |
| `image` | An AMI id, or `resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id` for the current Ubuntu 24.04 |
| `subnetId` | The subnet machines start in; it needs a route to the Work server and the container registry |
| `securityGroupIds` | Optional; outbound HTTPS is all a worker needs, nothing inbound |
| `rootVolumeGb` | Optional; gp3, encrypted, deleted with the instance. Size it for the machine's workspaces (see Disk) |
| `rootDeviceName` | Optional; `/dev/sda1` (Ubuntu) by default |
| `market` | `on-demand` (default) or `spot` (the policy's `spot-instances-request` resource allows it). A Spot interruption ends the machine and every review on it; Work replaces the machine, not the review |
| `instanceProfile` | Optional instance profile name (needs `iam:PassRole`) |
| `tags` | Optional extra tags; a machine with no known launch key is found by its name and these, so use one (`work-server: prod`) when several servers share an account |

AWS credentials are the project secrets `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, read in the steps only.

## IAM policy

Give the credentials only this policy, with your region, account, subnet,
security groups and class name. Launching is allowed only with the
`work-class` tag on the request, tags only at launch, and termination
only of instances carrying that tag. `DescribeInstances` cannot be limited
by tag in IAM (EC2 evaluates it against every resource); it reads only.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LaunchWorkMachines",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": [
        "arn:aws:ec2:eu-west-1:111122223333:instance/*",
        "arn:aws:ec2:eu-west-1:111122223333:volume/*"
      ],
      "Condition": {
        "StringEquals": { "aws:RequestTag/work-class": "review" },
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["work-machine", "work-rule", "work-class", "Name"]
        }
      }
    },
    {
      "Sid": "LaunchFromTheseResources",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": [
        "arn:aws:ec2:eu-west-1::image/*",
        "arn:aws:ec2:eu-west-1:111122223333:subnet/subnet-0123456789abcdef0",
        "arn:aws:ec2:eu-west-1:111122223333:security-group/sg-0123456789abcdef0",
        "arn:aws:ec2:eu-west-1:111122223333:network-interface/*",
        "arn:aws:ec2:eu-west-1:111122223333:spot-instances-request/*"
      ]
    },
    {
      "Sid": "TagOnlyAtLaunch",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": [
        "arn:aws:ec2:eu-west-1:111122223333:instance/*",
        "arn:aws:ec2:eu-west-1:111122223333:volume/*"
      ],
      "Condition": { "StringEquals": { "ec2:CreateAction": "RunInstances" } }
    },
    {
      "Sid": "TerminateOnlyWorkMachines",
      "Effect": "Allow",
      "Action": "ec2:TerminateInstances",
      "Resource": "arn:aws:ec2:eu-west-1:111122223333:instance/*",
      "Condition": {
        "StringEquals": { "aws:ResourceTag/work-class": "review" }
      }
    },
    {
      "Sid": "FindMachines",
      "Effect": "Allow",
      "Action": "ec2:DescribeInstances",
      "Resource": "*"
    },
    {
      "Sid": "ResolveTheImage",
      "Effect": "Allow",
      "Action": "ssm:GetParameters",
      "Resource": "arn:aws:ssm:eu-west-1::parameter/aws/service/*"
    }
  ]
}
```

Add each key of the class's `tags` to `aws:TagKeys`. A root volume
encrypted with a customer managed key also needs `kms:CreateGrant` and
`kms:GenerateDataKeyWithoutPlaintext` on that key.

## Set up the class and a rule

Whoever runs the server adds the class to `WORK_MACHINES_CONFIG` and
restarts it:

```json
{
  "classes": {
    "review": {
      "platform": "workflow",
      "project": "<this project's id>",
      "create": "createMachine",
      "destroy": "destroyMachine",
      "sandbox": "container",
      "options": {
        "region": "eu-west-1",
        "instanceType": "r7i.2xlarge",
        "image": "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
        "subnetId": "subnet-0123456789abcdef0",
        "securityGroupIds": ["sg-0123456789abcdef0"],
        "rootVolumeGb": 100
      }
    }
  }
}
```

`"sandbox": "container"` runs gVisor, which a `review` Environment whose
setup has its own network needs. Then a rule creates machines while
reviews wait and destroys them once idle, for the reviewing project
(often another project than this one):

```http
PUT /_work/operator/machine-rules/review
{ "projects": ["<review project id>"], "machines": { "demand": { "max": 8, "idleMinutes": 10, "enrollMinutes": 15 } }, "class": "review", "labels": { "pool": "review" } }
```

For one review chat per machine, size the review Environment's
`requirements.resources` to most of the machine, so a second review does
not fit and gets a machine of its own: on an `r7i.2xlarge` (8 vCPUs,
64 GiB) leave a core and some memory for the worker,
`"resources": { "cpuMillis": 7000, "memoryMb": 57344 }`. Each review then
waits up to the Environment's `waitMinutes` for its machine.

Turn `createMachine` and `destroyMachine` on for the project (not for
yourself): Work uses only the project's automation, with the secrets it
declares. Workflow runs stay on the Work server, never on the machines
they make.

## Disk

Everything a machine's workspaces hold lives on its root volume: each
review's checkout and installed dependencies, the overlay over the cache,
the copies of caches, Environment images, and with `containers` each
sandbox's own Docker data. Set `rootVolumeGb` so one machine's workspaces
fit with room to spare: for one review per machine, about 100 GB holds a
large repository, its dependencies, a cache and a few images. EC2's
default root volume for Ubuntu is 8 GB, which one review can fill.

The machine keeps a floor of free space (`WORK_DISK_FLOOR_MB` on the
worker, by default 10% of the disk and at most 10 GiB) and takes no new
workspace below it; the work waits, and on demand Work makes another
machine for it. It removes what Work left there that nothing used for a
day (`WORK_IMAGE_RETENTION_HOURS`): unused images and the Docker data
inside sandboxes. A failure while the machine is short of disk says so,
and the project hears `machine.disk-low` once each time a machine falls
under its floor, with its disk report and the class's options.

Work replaces a machine short of disk itself: it gives it no new work
and destroys it through `destroyMachine` once it holds no work, so no
review is cut off; it still counts toward the rule's `max` until then.
When machines of the class come up short soon after connecting, the
class's disk is too small for its work: the rule makes no new machines
for an hour (or until it is written again), its status says so, and the
project hears `machine.disk-too-small`. Raise `rootVolumeGb`, then write
the rule again. A workflow on `machine.disk-low`
is for the team's own policy: an alert, or raising the class's
`rootVolumeGb` for the machines to come.

## When a machine does not come up

- The rule's status (`GET /_work/operator/machine-rules`) shows the latest
  failure: a refusal names EC2's error code, and "no automation" means the
  workflows are not turned on for the project.
- The project's runs of `createMachine` show each answer; a machine with an
  instance id that never enrolls usually cannot reach the Work server or
  the container registry. Read the instance's console output in EC2.
- A machine that enrolls but never connects stops the rule until it is
  written again (ADR 0258).

The project hears `machine.created`, `machine.connected`, `machine.lost`,
`machine.released`, `machine.destroyed`, `machine.disk-low` and
`machine.disk-too-small` as events with the machine's name (the rule's,
for the last), class, rule and instance id; workflows may trigger on them
for bookkeeping or alerts.
