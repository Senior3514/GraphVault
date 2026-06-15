# syntax=docker/dockerfile:1
#
# GraphVault sync server image (@graphvault/server).
#
# Multi-stage, workspace-aware build for the pnpm monorepo. Build context MUST
# be the repository root, e.g.:
#
#   docker build -f docker/server.Dockerfile -t graphvault-server .
#
# The runtime uses node:22 glibc ("slim") on purpose: `argon2` is a native
# addon whose prebuilt binaries target glibc. Alpine (musl) would force a
# source rebuild and extra build tooling, so we stay on glibc.

# ---------------------------------------------------------------------------
# Stage 1 — builder: install workspace deps and compile TypeScript.
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# Enable the repo-pinned pnpm via corepack (see root package.json packageManager).
ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:$PATH"
RUN corepack enable

# Copy the manifests first so dependency installation is cached independently of
# source changes. We copy every workspace package.json that pnpm needs to build
# the lockfile-consistent dependency graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/sync-core/package.json packages/sync-core/

# Install the full (dev included) dependency set, exactly per the lockfile.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Bring in the sources needed to build shared -> server.
COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/

# Build the dependency package first, then the server.
RUN pnpm --filter @graphvault/shared build \
    && pnpm --filter @graphvault/server build

# Generate the Prisma client so the optional postgres backend works at runtime.
# The default in-memory backend never imports this, so a failure here would not
# affect memory mode — but generation is offline and reliable, so we run it.
#
# prisma:generate writes to src/store/generated/prisma (per schema `output`).
# At runtime the compiled store/prisma.js resolves `./generated/prisma/index.js`
# relative to dist/store/, so the generated client must also live under dist/.
# Copy it there (tsc -b does not emit non-.ts files).
RUN pnpm --filter @graphvault/server prisma:generate \
    && mkdir -p apps/server/dist/store \
    && cp -R apps/server/src/store/generated apps/server/dist/store/generated

# Note: we intentionally keep the full (dev-inclusive) dependency tree for the
# runtime stage rather than running `pnpm install --prod`. The optional postgres
# path needs the `prisma` CLI (for `migrate deploy`) and the `@prisma/client`
# query-engine binary, both declared as devDependencies of the server. Pruning
# them would break postgres mode; the image stays simple and correct instead.

# ---------------------------------------------------------------------------
# Stage 2 — runtime: slim image, non-root, healthchecked.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Listen on all interfaces inside the container (the app defaults to 127.0.0.1,
# which would be unreachable from outside the container).
ENV GRAPHVAULT_HOST=0.0.0.0
ENV GRAPHVAULT_PORT=4000
# Default on-disk location for blob bytes; mount a volume here to persist.
ENV GRAPHVAULT_DATA_DIR=/data

# Copy the built workspace and pruned dependencies from the builder.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/apps/server/prisma ./apps/server/prisma

# Create the data dir and hand ownership to the unprivileged `node` user that
# ships with the official image, then drop privileges.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4000

# Liveness probe hits the unauthenticated health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GRAPHVAULT_PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
