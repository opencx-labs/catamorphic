---
name: machines-install
description: Build a Work worker install script or its cloud-init.
---

# Install a Work worker

Use `workerUserData({ enrollment, image, sandbox })` to boot a new Linux
worker. Set `baked: true` when Docker and its sandbox runtime are in
the image already. Set `registry: "ecr"` for a private ECR worker image. Pass a pinned image and keep the worker's data directory on a
persistent disk. Its credential and key are written there on first start.
If operators need a browser-accessible install script, mount
`registerInstallScriptRoute` in the host's `hooks.routes`.
