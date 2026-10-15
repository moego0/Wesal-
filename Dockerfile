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

# Build Next.js app with build-time placeholder environment variables.
# Real credentials will be provided by Render / host at runtime.
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    REDIS_URL="redis://localhost:6379" \
    SESSION_SECRET="build_session_secret_at_least_32_characters_long_for_docker" \
    REQUIRE_PRODUCTION_CONFIG=0

RUN npm run build

# ─── Stage 3: runner ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Copy runtime assets and application files
COPY --from=builder /app/public            ./public
COPY --from=builder /app/.next             ./.next
COPY --from=builder /app/node_modules      ./node_modules
COPY --from=builder /app/package.json      ./package.json
COPY --from=builder /app/next.config.ts    ./next.config.ts
COPY --from=builder /app/prisma.config.ts  ./prisma.config.ts
COPY --from=builder /app/prisma            ./prisma
COPY --from=builder /app/src               ./src

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Default: run the Next.js web server.
# Override CMD in docker-compose / k8s to run the worker instead:
#   command: ["node", "--dns-result-order=ipv4first", "node_modules/.bin/tsx", "src/worker/index.ts"]
CMD ["npm", "run", "start"]
