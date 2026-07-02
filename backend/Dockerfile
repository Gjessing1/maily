# syntax=docker/dockerfile:1
# Multi-stage build for the maily backend (native better-sqlite3 needs build tools).
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
# Single, deterministic install for every workspace. This is the ONLY place deps are
# installed now — CI no longer runs a separate `npm ci` before the build (see the
# workflow files), so the tree (and the better-sqlite3 native compile) is built once.
#   --mount=type=cache  persists npm's download cache across builds on the BuildKit
#                       daemon, so a lockfile change re-extracts but doesn't re-download.
#   --foreground-scripts surfaces the better-sqlite3 make/g++ compile in the logs.
#   --loglevel verbose   shows per-package work so we can see where time goes on the
#                        slow N150 runner; dial back to the default once diagnosed.
# The whole layer is cached and only re-runs when package-lock.json changes.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root \
  --no-audit --no-fund --prefer-offline --foreground-scripts --loglevel verbose
COPY . .
# Quality gate baked into the image build: format, lint, types and unit tests. If any
# fail the build fails, so nothing gets tagged or pushed — same gate the old standalone
# `verify` job gave us, but without a second install on a second machine.
RUN npm run format:check && npm run lint && npm run typecheck && npm test
RUN npm run build -w @maily/backend
# Build the PWA too; its dist/ is served by the backend in production (no proxy).
# GIT_SHA (CI build-arg; .git is dockerignored so it can't be derived here) is baked
# into the bundle as the build id shown in Settings → About.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN npm run build -w @maily/frontend
# Drop dev dependencies (vite, typescript, eslint, drizzle-kit, @types, …) so the
# runtime image ships only production deps. better-sqlite3 was already compiled
# above, so prune just removes packages — no native rebuild needed.
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Same build id for the backend (/api/config), so Settings can compare app vs server.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/drizzle ./backend/drizzle
# Built PWA → backend/public, where src/http/static.ts serves it (same origin).
COPY --from=build /app/frontend/dist ./backend/public
WORKDIR /app/backend
EXPOSE 3000
CMD ["node", "dist/index.js"]
