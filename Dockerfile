# https://hub.docker.com/layers/library/node/22-alpine
ARG NODE_IMAGE=node:22-alpine@sha256:4d64b49e6c891c8fc821007cb1cdc6c0db7773110ac2c34bf2e6960adef62ed3
FROM ${NODE_IMAGE} AS builder

WORKDIR /app


COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM ${NODE_IMAGE}
WORKDIR /app

# Update npm to the latest version in production stage as well
RUN npm install -g npm@latest

# Explicitly copy package.json and package-lock.json to the root of /app
COPY package.json package-lock.json ./

# Copy the compiled application files
COPY --from=builder /app/dist ./dist

# Copy the node_modules from the builder
COPY --from=builder /app/node_modules ./node_modules/

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--transport", "http"]