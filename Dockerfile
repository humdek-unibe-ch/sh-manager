# SPDX-FileCopyrightText: 2026 Humdek, University of Bern
# SPDX-License-Identifier: MPL-2.0
#
# SelfHelp Manager image.
#
# This is the ONE privileged tool that talks to Docker. At runtime it is given
# the host Docker socket + the /opt/selfhelp data root. Instance runtime
# containers are never built or run from this image and never receive the
# socket.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS runtime
# The Docker CLI + compose v2 plugin are required (the manager runs
# `docker compose ...`); the daemon is the host's, reached through the mounted
# socket. docker-compose-plugin only ships from Docker's own apt repo, not
# Debian's, so we add it here and install the client only (no daemon).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV SELFHELP_ROOT=/opt/selfhelp
# The compiled output in dist/ is self-contained (tsc-alias rewrites every
# @shm/* import to a relative dist path), so the runtime only needs the root's
# third-party deps. --no-workspaces lets npm ci resolve them from the lock
# without the workspace source dirs (which are intentionally not shipped).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-workspaces
COPY --from=build /app/dist ./dist
COPY packages/schemas/examples ./packages/schemas/examples
ENTRYPOINT ["node", "dist/apps/cli/src/bin.js"]
CMD ["--help"]
