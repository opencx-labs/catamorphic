# A Linux machine for the container backend's real-sandbox tests
# (scripts/test-in-docker.sh): Docker's static engine from docker:dind, gVisor
# installed the documented way, Node for Vitest and Bun for the workspace. Run
# it privileged; its entrypoint starts the engine with a `runsc` runtime.
# Every version is pinned, so an upstream release never changes a test run;
# move them forward deliberately, gVisor with the CI job's.
FROM docker:29.9.3-dind@sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121 AS docker

# Bootstrap only: workspace installation supplies checksum-verified Node
# 26.13.1; repository builds and tests resolve that runtime, not this binary.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates curl git iptables procps xz-utils \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/ /usr/local/bin/
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# gVisor's release archive (https://gvisor.dev/docs/user_guide/install/) of
# one dated release, checked against the SHA-512 recorded here. runsc runs
# its sidecars from gvisor-bin/ beside it, so the whole archive is unpacked.
ARG GVISOR_RELEASE=20261102
RUN set -e; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64) sum=2e6671bb2d033b871c5811ab57e16ac570988b0e0054c525f911cfaf191bab3ca4efb08e0a98daa4b9e7d248f9e5776ef2ef2f8a6b82d829646a42924c98bb05 ;; \
    aarch64) sum=574b5775b4417618f63c8506e6bb237e370df85722832a5d0c3831382155e55e59d4cfa993a1e9bbe1b1cf04346ffd48b20aaa879c6ed9a52c680f762fd19980 ;; \
    *) echo "No gVisor checksum recorded for $arch" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  curl -fsSLO "https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${arch}/gvisor.tar.bz2"; \
  echo "${sum}  gvisor.tar.bz2" | sha512sum -c -; \
  tar -xjf gvisor.tar.bz2 -C /usr/local/bin; \
  chmod a+rx /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1; \
  rm -f gvisor.tar.bz2; \
  runsc --version
RUN npm install -g bun@1.4.4 && bun --version
# Work's runtime arguments (ADR 0204): host sockets for the egress proxy,
# raw sockets for nested Docker.
RUN mkdir -p /etc/docker && printf '%s\n' \
  '{"runtimes":{"runsc":{"path":"/usr/local/bin/runsc","runtimeArgs":["--host-uds=open","--net-raw"]}}}' \
  > /etc/docker/daemon.json
ENTRYPOINT ["dind"]
CMD ["sh", "-c", "dockerd >/var/log/dockerd.log 2>&1 & exec sleep infinity"]
