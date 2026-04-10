# https://hub.docker.com/layers/library/node/22-alpine
ARG NODE_IMAGE=node:22-alpine@sha256:4d64b49e6c891c8fc821007cb1cdc6c0db7773110ac2c34bf2e6960adef62ed3
FROM ${NODE_IMAGE} AS builder

WORKDIR /app


COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# remove dev dependencies, keeping compiled native modules intact
RUN npm prune --omit=dev

# Production stage
FROM ${NODE_IMAGE}
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules/

# run as non-root (node user is built into node:alpine images)
USER node

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--transport", "http"]
