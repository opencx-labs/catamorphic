# The review Environment's image. Review machines build it once and cache it
# by digest. docker:dind supplies dockerd and the docker CLI (with compose),
# so the reviewer can start a change's services inside its own sandbox.
FROM docker:29.9.3-dind@sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121
RUN apk add --no-cache bash curl git jq nodejs npm postgresql-client python3 \
  && npm install --global bun@1.4.4 pnpm@12.18.0
WORKDIR /workspace
