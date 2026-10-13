# syntax=docker/dockerfile:1

# Diggame runs on Node's built-in node:sqlite, so there is no build step and no
# system database to install - the image is just the app and its two runtime
# dependencies.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/diggame.db

WORKDIR /app

# Copy the manifests first so the dependency layer is cached until they change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY public ./public
COPY server ./server
COPY server.js ./

# The SQLite file lives in /app/data; make it writable by the non-root user
# before dropping privileges.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 3000
VOLUME ["/app/data"]

# The static index is served at "/", so that is enough to tell the HTTP layer is
# up. Plain node fetch keeps the healthcheck free of extra packages.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
