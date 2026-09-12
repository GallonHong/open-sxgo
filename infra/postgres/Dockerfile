FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages packages
COPY migrations-postgres migrations-postgres
COPY scripts/migrate-postgres.ts scripts/migrate-postgres.ts
USER node
ENV WFD_BIND_HOST=0.0.0.0
EXPOSE 8788
CMD ["node", "--import", "tsx", "apps/api/src/node-postgres.ts"]
