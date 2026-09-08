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
 && rm -rf /opt/amplifier-src/.git \
 && ln -s /opt/amplifier-src/.venv/bin/amplifier /usr/local/bin/amplifier \
 && node --version | grep -Fx 'v22.23.2' \
 && claude --version | grep -F "${CLAUDE_CODE_VERSION}" \
 && codex --version | grep -F "${CODEX_VERSION}" \
 && opencode --version | grep -Fx "${OPENCODE_VERSION}" \
 && /opt/amplifier-src/.venv/bin/python -c 'import importlib.metadata as m; assert m.version("amplifier-app-cli") == "0.1.1"' \
 && /lib/x86_64-linux-gnu/libc.so.6 | grep -F '2.39'

WORKDIR /workspace
CMD ["/bin/bash"]
