FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:22-alpine
WORKDIR /app

# Explicitly copy package.json and package-lock.json to the root of /app
COPY package.json package-lock.json ./

# Copy the compiled application files
COPY --from=builder /app/dist ./dist

# Copy the node_modules from the builder (as per the previous successful attempt)
COPY --from=builder /app/node_modules ./node_modules/

ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]