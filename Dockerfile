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
# The Docker CLI (compose plugin) is required; the daemon is the host's, reached
# through the mounted socket. Keep the image minimal otherwise.
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io docker-compose-plugin ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV SELFHELP_ROOT=/opt/selfhelp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY packages/schemas/examples ./packages/schemas/examples
ENTRYPOINT ["node", "dist/apps/cli/src/bin.js"]
CMD ["--help"]
