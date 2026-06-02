# Multi-stage build for the maily backend (native better-sqlite3 needs build tools).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm install --workspaces --include-workspace-root
COPY . .
RUN npm run build -w @maily/backend
# Build the PWA too; its dist/ is served by the backend in production (no proxy).
RUN npm run build -w @maily/frontend

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
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
