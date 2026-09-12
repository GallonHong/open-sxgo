FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/protocol packages/protocol
COPY packages/domain packages/domain
COPY packages/verifier packages/verifier
COPY packages/mirror-sync packages/mirror-sync
COPY scripts/serve-mirror.ts scripts/serve-mirror.ts
RUN mkdir /data && chown node:node /data
USER node
ENV MIRROR_DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node","--import","tsx","scripts/serve-mirror.ts"]
