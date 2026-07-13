# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/18861870889/this-is-javis-2"
LABEL org.opencontainers.image.description="Local-first Jarvis brain for StackChan, Xiaozhi, Home Assistant, and PC tasks"

ENV NODE_ENV=production \
    JARVIS_BIND_HOST=0.0.0.0 \
    PORT=5173 \
    HARNESS_EXECUTION_MODE=dry_run

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node src ./src
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 5173
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5173/api/runtime/status').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.mjs"]
