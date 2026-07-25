# syntax=docker/dockerfile:1.7
# Multi-stage build for hypermove-fce-extension — the TypeScript/Hono
# POST /action handler this docker-compose's `extension-tee` service can run
# INSTEAD OF the Go extension-scaffold binary (see ../docker-compose.override.yaml
# in this directory, and services/tee-extension/README.md for the Go original).
#
# Runs as an ordinary container, NOT inside a GCP Confidential Space VM itself —
# per the PRD's execution_environment, the TEE isolation boundary is the real
# Flare `extension-tee` (Go) container this service sits behind; this service
# is the "task logic" the TEE node forwards decoded actions to over the
# loopback Docker network, the same relationship extension-scaffold's own
# Dockerfile has to the real tee-node binary.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 fce && adduser --system --uid 1001 fce

COPY --from=builder --chown=fce:fce /app/dist ./dist
COPY --from=builder --chown=fce:fce /app/package.json ./package.json
COPY --from=deps --chown=fce:fce /app/node_modules ./node_modules

USER fce

# Matches PORTS.action in src/config.ts (Flare's real ExtensionPort default).
# Override via TEE_EXTENSION_PORT to match a non-default deployment (the real
# Coston2/local-e2e docker-compose in this repo uses 7702, not 8889 — see
# services/tee-extension/extension-examples/extension-scaffold/docker-compose.yaml).
EXPOSE 8889

CMD ["node", "dist/index.js"]
