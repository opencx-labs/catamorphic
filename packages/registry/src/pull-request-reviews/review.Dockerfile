# The review Environment's image. Review machines build it once and cache it
# by digest. docker:dind supplies dockerd and the docker CLI (with compose),
# so the reviewer can start a change's services inside its own sandbox.
FROM docker:27-dind
RUN apk add --no-cache bash curl git jq nodejs npm postgresql-client python3 \
  && npm install --global bun@1 pnpm@10
WORKDIR /workspace
