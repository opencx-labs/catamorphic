---
name: machines-ec2
description: Connect your Work server's machines hook to Amazon EC2.
---

# Worker machines on EC2

Copy `machines-ec2.ts` into your Work server host. Pass `ec2Machines` the
region, default instance type, image and subnet, a stable tag for this
deployment, and a `userData` function. Use `workerUserData` from
`machines-install` for either a stock Linux image or a baked image. For a
private worker image, give the instance profile pull-only registry access
and supply the registry login command to the install recipe.

```ts
const machines = {
  plan,
  ...ec2Machines({
    region: "eu-west-1",
    defaults: { instanceType: "m7i.large", image: amiId, subnetId, rootVolumeGb: 100 },
    tags: { "work-server": "prod" },
    userData: ({ enrollment }) => workerUserData({ enrollment, image: workerImage }),
  }),
};
```

EC2 deduplicates launches by the Work enrollment's client token. On-demand
instances keep their encrypted root disk across stops and starts. Use a
plan that drains and destroys Spot instances when idle. EC2's APIs may
take several passes to report that a stopped, started, or terminated
instance has reached its target state.

## IAM policy

Give the credentials only this policy, with your region, account, subnet,
security groups and class name. Launching is allowed only with the
`work-server` tag on the request, tags only at launch, and termination
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
        "StringEquals": { "aws:RequestTag/work-server": "prod" },
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["work-machine", "work-server", "Name"]
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
      "Action": ["ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances"],
      "Resource": "arn:aws:ec2:eu-west-1:111122223333:instance/*",
      "Condition": {
        "StringEquals": { "aws:ResourceTag/work-server": "prod" }
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

Add each key of the host's `tags` to `aws:TagKeys`. A root volume
encrypted with a customer managed key also needs `kms:CreateGrant` and
`kms:GenerateDataKeyWithoutPlaintext` on that key.
