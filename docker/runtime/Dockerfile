# syntax=docker/dockerfile:1.7
# Copy exact Node 22 bits from the official Node image into the Ubuntu 24.04
# runtime ABI used to build freshell-session-host. Both inputs are digest-pinned.
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS node-source

FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
ARG CLAUDE_CODE_VERSION=2.1.263
ARG CODEX_VERSION=0.147.0
ARG OPENCODE_VERSION=1.18.21
ARG AMPLIFIER_APP_CLI_COMMIT=1873aa980535c99a743b17172e4231833f6c8741
ARG AMPLIFIER_UV_VERSION=0.8.22
ARG AMPLIFIER_PROVIDER_ANTHROPIC_COMMIT=4cf78c792dd214233d16b373e824135de5687957
ARG AMPLIFIER_ANTHROPIC_SDK_VERSION=1.0.0
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=node-source /usr/local/ /usr/local/
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git openssh-client procps python3 python3-venv make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
 && python3 -m venv /opt/uv \
 && /opt/uv/bin/pip install --no-cache-dir "uv==${AMPLIFIER_UV_VERSION}" \
 && git clone --filter=blob:none https://github.com/microsoft/amplifier-app-cli /opt/amplifier-src \
 && git -C /opt/amplifier-src checkout --detach "${AMPLIFIER_APP_CLI_COMMIT}" \
 && /opt/uv/bin/uv sync --locked --no-dev --project /opt/amplifier-src \
 && git clone --filter=blob:none https://github.com/microsoft/amplifier-module-provider-anthropic /opt/amplifier-provider-anthropic \
 && git -C /opt/amplifier-provider-anthropic checkout --detach "${AMPLIFIER_PROVIDER_ANTHROPIC_COMMIT}" \
 && git -C /opt/amplifier-provider-anthropic rev-parse HEAD | grep -Fx "${AMPLIFIER_PROVIDER_ANTHROPIC_COMMIT}" \
 && /opt/uv/bin/uv pip install --python /opt/amplifier-src/.venv/bin/python "anthropic==${AMPLIFIER_ANTHROPIC_SDK_VERSION}" \
 && /opt/uv/bin/uv pip install --python /opt/amplifier-src/.venv/bin/python --no-deps /opt/amplifier-provider-anthropic \
 && rm -rf /opt/amplifier-src/.git \
 && rm -rf /opt/amplifier-provider-anthropic/.git \
 && ln -s /opt/amplifier-src/.venv/bin/amplifier /usr/local/bin/amplifier \
 && node --version | grep -Fx 'v22.23.2' \
 && claude --version | grep -F "${CLAUDE_CODE_VERSION}" \
 && codex --version | grep -F "${CODEX_VERSION}" \
 && opencode --version | grep -Fx "${OPENCODE_VERSION}" \
 && /opt/amplifier-src/.venv/bin/python -c 'import importlib.metadata as m; assert m.version("amplifier-app-cli") == "0.1.1"' \
 && /opt/amplifier-src/.venv/bin/python -c 'import importlib.metadata as m; assert m.version("anthropic") == "1.0.0"; assert m.version("amplifier-module-provider-anthropic") == "1.0.0"' \
 && /lib/x86_64-linux-gnu/libc.so.6 | grep -F '2.39'

COPY --chmod=0755 docker/runtime/amplifier-onecli /usr/local/bin/freshell-amplifier-onecli
COPY --chmod=0644 docker/runtime/amplifier-onecli-haiku-low.yaml /etc/freshell/amplifier-onecli-haiku-low.yaml

# FreshClaude/Kilroy run inside the soul host, so their JS SDK bridge and its
# pinned dependency must be part of the workload image rather than resolved
# through a web-server worktree path.
COPY crates/freshell-claude-sidecar/package.json crates/freshell-claude-sidecar/package-lock.json /opt/freshell-claude-sidecar/
RUN cd /opt/freshell-claude-sidecar && npm ci --omit=dev --ignore-scripts
COPY crates/freshell-claude-sidecar/*.mjs /opt/freshell-claude-sidecar/

WORKDIR /workspace
CMD ["/bin/bash"]
