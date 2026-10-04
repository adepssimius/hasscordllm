# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.30

FROM ${UV_IMAGE} AS uv

# ---- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

COPY package.json pnpm-lock.yaml ./
# NOTE: do not pass --no-optional / --ignore-optional here. The Agent SDK ships
# its Claude Code binary as an npm optional dependency; skipping optionals
# produces an image that fails at runtime with a missing-executable error.
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- ha-mcp ------------------------------------------------------------------
# The Home Assistant MCP server, pinned. It needs Python 3.13+, which bookworm
# does not ship, so uv fetches a standalone interpreter. Both live under /opt so
# the runtime stage can copy them across with their paths intact — the tool's
# venv points at the interpreter by absolute path.
FROM ${NODE_IMAGE} AS hamcp
ARG HA_MCP_VERSION=8.6.0
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/opt/uv/bin \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && uv tool install --python 3.13 "ha-mcp==${HA_MCP_VERSION}" \
 && /opt/uv/tools/ha-mcp/bin/python -c "import ha_mcp.server"

# ---- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# No git, no python on PATH beyond ha-mcp's own: the agent has no shell, and
# nothing else here runs scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=hamcp /opt/uv /opt/uv
RUN ln -s /opt/uv/bin/ha-mcp /usr/local/bin/ha-mcp

# Runtime deps only, optionals included so the bundled Claude Code binary is present.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate \
 && pnpm install --frozen-lockfile --prod \
 && pnpm store prune

COPY --from=build /app/dist ./dist

# HOME must be writable and persistent: the SDK keeps session transcripts
# beneath it, and resuming a thread after a restart depends on them still being
# there. /data is the volume mount.
ENV NODE_ENV=production \
    HOME=/data/home \
    DATA_DIR=/data \
    HTTP_PORT=8080 \
    HA_MCP_COMMAND=/usr/local/bin/ha-mcp

RUN groupadd -g 10001 app && useradd -u 10001 -g app -d /data -s /usr/sbin/nologin app
USER 10001:10001

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
