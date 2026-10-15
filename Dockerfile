# ─── Stage 1: deps ───────────────────────────────────────────────────────────
# Install production + dev dependencies so the build stage can use them.
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ─── Stage 2: builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY . .

# Generate Prisma client (must happen before build)
RUN npx prisma generate

# Build Next.js app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── Stage 3: runner ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Copy only what's needed to run
COPY --from=builder /app/public            ./public
COPY --from=builder /app/.next             ./.next
COPY --from=builder /app/node_modules      ./node_modules
COPY --from=builder /app/package.json      ./package.json
COPY --from=builder /app/prisma            ./prisma
COPY --from=builder /app/src/generated     ./src/generated
# Worker entrypoint
COPY --from=builder /app/src/worker        ./src/worker
COPY --from=builder /app/src/server        ./src/server
COPY --from=builder /app/src/lib           ./src/lib
COPY --from=builder /app/src/proxy.ts      ./src/proxy.ts

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Default: run the Next.js web server.
# Override CMD in docker-compose / k8s to run the worker instead:
#   command: ["node", "--dns-result-order=ipv4first", "node_modules/.bin/tsx", "src/worker/index.ts"]
CMD ["npm", "run", "start"]
