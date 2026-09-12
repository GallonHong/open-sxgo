FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages packages
COPY migrations migrations
RUN mkdir -p /app/.runtime/private && chown -R node:node /app/.runtime
USER node
EXPOSE 8787
CMD ["node","--import","tsx","apps/api/src/node.ts"]
