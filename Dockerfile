# https://hub.docker.com/layers/library/node/22-alpine
ARG NODE_IMAGE=node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
FROM ${NODE_IMAGE} AS builder

WORKDIR /app


# pnpm-workspace.yaml carries `overrides` and `onlyBuiltDependencies`; without it
# the install would skip the native build scripts for @confluentinc/kafka-javascript
# (and others), producing an image whose native addon never gets compiled.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install any recent pnpm; it reads package.json's `packageManager` field and
# self-switches to the pinned version, keeping that field the single source of
# truth shared with CI and local dev (no version pin or Corepack needed).
RUN npm install --global pnpm && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY assets/ ./assets/

RUN pnpm run build

# remove dev dependencies, keeping compiled native modules intact. pnpm uses
# relative symlinks with the .pnpm store nested under node_modules, so the
# pruned node_modules copies cleanly into the production stage below.
# --ignore-scripts skips the `prepare` lifecycle (husky), which pnpm runs after
# pruning; husky is a devDependency that prune just removed, so without this the
# step dies on `sh: husky: not found`
RUN pnpm prune --prod --ignore-scripts

# Production stage
FROM ${NODE_IMAGE}
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/node_modules ./node_modules/

# run as non-root (node user is built into node:alpine images)
USER node

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--transport", "http"]
