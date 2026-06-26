# Multi-stage build — keeps the final image lean
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Final image ----
FROM node:20-alpine
RUN addgroup -S chama && adduser -S chama -G chama

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Create logs directory with correct permissions
RUN mkdir -p logs && chown -R chama:chama /app

USER chama
EXPOSE 3000

# Emit "ready" signal for PM2 wait_ready
CMD ["node", "server.js"]
