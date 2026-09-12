FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv faketime && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/protocol packages/protocol
COPY packages/domain packages/domain
COPY packages/verifier packages/verifier
COPY scripts/conformance scripts/conformance
COPY .runtime/tuf-conformance /suite
RUN python3 -m venv /suite/env && /suite/env/bin/pip install /suite
WORKDIR /suite
CMD ["/suite/env/bin/pytest","tuf_conformance","--entrypoint","/app/scripts/conformance/client","--json-report","--json-report-file=/reports/conformance.json","-q"]
