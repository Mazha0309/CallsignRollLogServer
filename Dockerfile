# syntax=docker/dockerfile:1.7

# Keep all installs and builds in one stage. BuildKit otherwise executes the
# independent server, Web portal, and Live Share stages in parallel, which can
# make small hosts spend hours swapping under three concurrent Node workloads.
FROM node:24.18.0-bookworm AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV MAKEFLAGS="-j1" \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

# Install each dependency tree before copying sources so lockfile layers remain
# cacheable. The shared BuildKit cache also avoids downloading common packages
# again for the Web portal and Live Share application.
WORKDIR /build/server
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=openlogtool-npm-cache,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline

WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=openlogtool-npm-cache,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline

WORKDIR /build/live
COPY live/package.json live/package-lock.json ./
RUN --mount=type=cache,id=openlogtool-npm-cache,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline

# Build sequentially to keep peak memory predictable on low-resource servers.
WORKDIR /build/server
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

WORKDIR /build/web
COPY web/ ./
RUN npm run build

WORKDIR /build/live
COPY live/ ./
RUN npm run build

FROM node:24.18.0-bookworm-slim
WORKDIR /app
# Build contexts may be checked out with a restrictive umask. The runtime
# user must own the copied files, including package.json and static assets.
COPY --from=builder --chown=node:node /build/server/dist ./dist
COPY --from=builder --chown=node:node /build/server/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/server/package.json ./
COPY --from=builder --chown=node:node /build/web/dist ./web/dist
COPY --from=builder --chown=node:node /build/live/dist ./live/dist
RUN mkdir -p /app/data && chown node:node /app/data

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/server-info').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
