# https://hub.docker.com/layers/library/node/22-alpine
ARG NODE_IMAGE=node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
FROM ${NODE_IMAGE} AS builder

WORKDIR /app


COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
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
