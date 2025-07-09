FROM node:22-alpine AS builder

WORKDIR /app

RUN npm install -g npm@latest

RUN apk update && apk upgrade

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:22-alpine
WORKDIR /app

# Update npm to the latest version in production stage as well
RUN npm install -g npm@latest

# Update Alpine packages to fix CVE-2025-4575 (OpenSSL vulnerability)
RUN apk update && apk upgrade

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