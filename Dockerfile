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
# Real credentials are provided by the host at runtime, not baked in here.
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

# Copy runtime assets and application files.
#
# `--chown` matters for `.next`: `next start` writes the image-optimizer cache
# under `.next/cache` at request time, and files copied as root are not writable
# by the `nextjs` user. Without it every optimized image logs
# `EACCES: mkdir '/app/.next/cache/images'` and the cache never fills.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next  ./.next
COPY --from=builder /app/node_modules      ./node_modules
COPY --from=builder /app/package.json      ./package.json
COPY --from=builder /app/next.config.ts    ./next.config.ts
COPY --from=builder /app/prisma.config.ts  ./prisma.config.ts
COPY --from=builder /app/prisma            ./prisma
COPY --from=builder /app/scripts           ./scripts
COPY --from=builder /app/src               ./src
COPY --from=builder /app/tsconfig.json     ./tsconfig.json

USER nextjs

# The builder ran `npm ci` as root, so /app/node_modules is root-owned. npx and
# the Prisma CLI both want a writable cache, and the worker shells out to
# `node_modules/.bin/prisma` at boot. Pointing HOME and the npm cache at
# locations this user owns avoids an EACCES crash-loop that only appears in
# production, where it is far more expensive to diagnose.
ENV HOME=/home/nextjs \
    npm_config_cache=/tmp/.npm

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Run both Next.js and the background worker concurrently in the same container.
CMD ["node", "scripts/start-all.mjs"]
