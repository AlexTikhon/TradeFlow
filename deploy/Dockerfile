# syntax=docker/dockerfile:1
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY e2e/package.json e2e/package.json
RUN --mount=type=cache,id=tradeflow-pnpm-11,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY apps/web apps/web
COPY deploy/verify-runtime-lock.js deploy/verify-runtime-lock.js
RUN pnpm build
RUN --mount=type=cache,id=tradeflow-pnpm-11,target=/pnpm/store pnpm --filter @tradeflow/api --prod deploy --legacy --frozen-lockfile --store-dir=/pnpm/store /runtime/api \
    && node deploy/verify-runtime-lock.js

# Explicit operator tooling; never run migrations or seed automatically with API startup.
FROM build AS tools
USER node
WORKDIR /workspace/apps/api
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /runtime/api ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=12 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS web
# The upstream binary has a low-port file capability. All listeners here are unprivileged;
# remove it so exec also works with cap_drop: ALL and no-new-privileges.
RUN setcap -r /usr/bin/caddy
COPY --from=build /workspace/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/routes.caddy /etc/caddy/routes.caddy
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
USER 1000:1000
EXPOSE 8080 8443
