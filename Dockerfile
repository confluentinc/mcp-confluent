FROM node:22-alpine AS builder

WORKDIR /app

# Update npm to the latest version to fix CVE-2024-21626 (brace-expansion vulnerability)
RUN npm install -g npm@latest

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

# Explicitly copy package.json and package-lock.json to the root of /app
COPY package.json package-lock.json ./

# Copy the compiled application files
COPY --from=builder /app/dist ./dist

# Copy the node_modules from the builder
COPY --from=builder /app/node_modules ./node_modules/

# Copy the entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set environment variables for HTTP transport
ENV NODE_ENV=production


# Expose the HTTP port
EXPOSE 8080

# Use the custom entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--transport", "http"]