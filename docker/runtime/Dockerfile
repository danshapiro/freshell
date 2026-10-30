# syntax=docker/dockerfile:1.7
# Copy exact Node 22 bits from the official Node image into the Ubuntu 24.04
# runtime ABI used to build freshell-session-host. Both inputs are digest-pinned.
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS node-source

# Export the Claude sidecar from the same frozen pnpm workspace lock used by
# the rest of Freshell. A hoisted production deploy carries its dependencies
# as a self-contained tree, without links back to this build workspace.
FROM node-source AS claude-sidecar
WORKDIR /sidecar-workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY crates/freshell-claude-sidecar/package.json crates/freshell-claude-sidecar/
COPY packages/freshell-mcp-runtime/package.json packages/freshell-mcp-runtime/
COPY crates/freshell-claude-sidecar/*.mjs crates/freshell-claude-sidecar/
RUN npm install --global pnpm@10.34.5 \
 && pnpm --filter freshell-claude-sidecar --prod --frozen-lockfile --config.node-linker=hoisted deploy /opt/freshell-claude-sidecar

# Bundle Freshell-owned MCP code from this checkout, then export only its
# lockfile-pinned runtime dependencies. The resulting entry has no worktree
# links and can run inside any managed soul. Keep build tools local to the
# package, and bundle into its published files before the production deploy.
FROM node-source AS mcp-runtime
WORKDIR /mcp-workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/freshell-mcp-runtime/package.json packages/freshell-mcp-runtime/
COPY tools/freshell-mcp/*.ts tools/freshell-mcp/
COPY tools/node-client-runtime/*.ts tools/node-client-runtime/
RUN npm install --global pnpm@10.34.5 \
 && pnpm --filter freshell-mcp-runtime install --frozen-lockfile --ignore-scripts \
 && pnpm --filter freshell-mcp-runtime exec esbuild ../../tools/freshell-mcp/server.ts \
      --bundle --platform=node --format=esm --packages=external --outfile=generated/server.js \
 && pnpm --filter freshell-mcp-runtime --prod --frozen-lockfile --config.node-linker=hoisted deploy /opt/freshell-mcp \
 && mv /opt/freshell-mcp/generated/server.js /opt/freshell-mcp/server.js

FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
ARG CLAUDE_CODE_VERSION=2.1.263
ARG CODEX_VERSION=0.147.0
ARG OPENCODE_VERSION=1.18.21
ARG BUN_VERSION=1.4.3
ARG AMPLIFIER_APP_CLI_COMMIT=1873aa980535c99a743b17172e4231833f6c8741
ARG AMPLIFIER_UV_VERSION=0.8.22
ARG AMPLIFIER_PROVIDER_VLLM_COMMIT=e1846e907b0ce90b3e8748346244e548fa0d3241
ARG AMPLIFIER_OPENAI_SDK_VERSION=2.8.1
ARG AMPLIFIER_OPENAI_HARMONY_VERSION=0.0.8
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=node-source /usr/local/ /usr/local/
COPY extensions/amplifier/freshell-native-resume.patch /opt/freshell-native-resume.patch
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git openssh-client procps python3 python3-venv make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "bun@${BUN_VERSION}" \
 && python3 -m venv /opt/uv \
 && /opt/uv/bin/pip install --no-cache-dir "uv==${AMPLIFIER_UV_VERSION}" \
 && git clone --filter=blob:none https://github.com/microsoft/amplifier-app-cli /opt/amplifier-src \
 && git -C /opt/amplifier-src checkout --detach "${AMPLIFIER_APP_CLI_COMMIT}" \
 && git -C /opt/amplifier-src rev-parse HEAD | grep -Fx '1873aa980535c99a743b17172e4231833f6c8741' \
 && echo 'fd305d3037fa6bc3087d5aa13ecbb9aba1c21a5a5a57cefd57dad394f54fe770  /opt/amplifier-src/amplifier_app_cli/session_store.py' | sha256sum --check \
 && echo '7be66414b114c3c2ea7a892b4ada3ae74289d417c73bef8f5cd6cacf944f1071  /opt/amplifier-src/amplifier_app_cli/session_runner.py' | sha256sum --check \
 && echo 'e2a04418d82731a37a98c228ed8a78bbe9ea4282db0d6410f22e8342db892c86  /opt/amplifier-src/amplifier_app_cli/runtime/config.py' | sha256sum --check \
 && git -C /opt/amplifier-src apply --check /opt/freshell-native-resume.patch \
 && git -C /opt/amplifier-src apply /opt/freshell-native-resume.patch \
 && /opt/uv/bin/uv sync --locked --no-dev --project /opt/amplifier-src \
 && git clone --filter=blob:none https://github.com/microsoft/amplifier-module-provider-vllm /opt/amplifier-provider-vllm \
 && git -C /opt/amplifier-provider-vllm checkout --detach "${AMPLIFIER_PROVIDER_VLLM_COMMIT}" \
 && git -C /opt/amplifier-provider-vllm rev-parse HEAD | grep -Fx "${AMPLIFIER_PROVIDER_VLLM_COMMIT}" \
 && /opt/uv/bin/uv pip install --python /opt/amplifier-src/.venv/bin/python \
      "openai==${AMPLIFIER_OPENAI_SDK_VERSION}" "openai-harmony==${AMPLIFIER_OPENAI_HARMONY_VERSION}" \
 && /opt/uv/bin/uv pip install --python /opt/amplifier-src/.venv/bin/python --no-deps /opt/amplifier-provider-vllm \
 && rm -rf /opt/amplifier-src/.git \
 && rm -rf /opt/amplifier-provider-vllm/.git \
 && ln -s /opt/amplifier-src/.venv/bin/amplifier /usr/local/bin/amplifier \
 && node --version | grep -Fx 'v22.23.2' \
 && claude --version | grep -F "${CLAUDE_CODE_VERSION}" \
 && codex --version | grep -F "${CODEX_VERSION}" \
 && opencode --version | grep -Fx "${OPENCODE_VERSION}" \
 && bun --version | grep -Fx "${BUN_VERSION}" \
 && /opt/amplifier-src/.venv/bin/python -c 'import importlib.metadata as m; assert m.version("amplifier-app-cli") == "0.1.1"' \
 && /opt/amplifier-src/.venv/bin/python -c 'import importlib.metadata as m; assert m.version("openai") == "2.8.1"; assert m.version("openai-harmony") == "0.0.8"; assert m.version("amplifier-module-provider-vllm") == "1.0.0"' \
 && /lib/x86_64-linux-gnu/libc.so.6 | grep -F '2.39'

# Preinstall the ordinary bundle modules so read-only provider runtimes
# resolve source-less references without a runtime dependency installer.
ARG AMPLIFIER_LOOP_BASIC_COMMIT=ae0954cc41be54afef3ca97181a0876a29ad1b4c
ARG AMPLIFIER_CONTEXT_SIMPLE_COMMIT=c7ec55db96888200ba619adedc857278daf787c5
ARG AMPLIFIER_HOOKS_LOGGING_COMMIT=a4efafc834938ea53006808313e840b1136cb296
RUN git clone --filter=blob:none https://github.com/microsoft/amplifier-module-loop-basic /opt/amplifier-loop-basic \
 && git -C /opt/amplifier-loop-basic checkout --detach "${AMPLIFIER_LOOP_BASIC_COMMIT}" \
 && git -C /opt/amplifier-loop-basic rev-parse HEAD | grep -Fx "${AMPLIFIER_LOOP_BASIC_COMMIT}" \
 && git clone --filter=blob:none https://github.com/microsoft/amplifier-module-context-simple /opt/amplifier-context-simple \
 && git -C /opt/amplifier-context-simple checkout --detach "${AMPLIFIER_CONTEXT_SIMPLE_COMMIT}" \
 && git -C /opt/amplifier-context-simple rev-parse HEAD | grep -Fx "${AMPLIFIER_CONTEXT_SIMPLE_COMMIT}" \
 && git clone --filter=blob:none https://github.com/microsoft/amplifier-module-hooks-logging /opt/amplifier-hooks-logging \
 && git -C /opt/amplifier-hooks-logging checkout --detach "${AMPLIFIER_HOOKS_LOGGING_COMMIT}" \
 && git -C /opt/amplifier-hooks-logging rev-parse HEAD | grep -Fx "${AMPLIFIER_HOOKS_LOGGING_COMMIT}" \
 && /opt/uv/bin/uv pip install --python /opt/amplifier-src/.venv/bin/python --no-deps /opt/amplifier-loop-basic /opt/amplifier-context-simple /opt/amplifier-hooks-logging \
 && rm -rf /opt/amplifier-loop-basic/.git \
 && rm -rf /opt/amplifier-context-simple/.git \
 && rm -rf /opt/amplifier-hooks-logging/.git \
 && /opt/amplifier-src/.venv/bin/python -c 'import importlib.metadata as m; assert m.version("amplifier-app-cli") == "0.1.1"; assert m.version("amplifier-core") == "1.6.0"; assert m.version("amplifier-foundation") == "1.0.0"; assert m.version("openai") == "2.8.1"; assert m.version("openai-harmony") == "0.0.8"; assert m.version("amplifier-module-provider-vllm") == "1.0.0"'

# The ordinary CLI always composes the modes behavior, including its context
# and definitions. Keep that complete bundle and install its ordinary modules
# before a provider enters the read-only runtime.
ARG AMPLIFIER_MODES_COMMIT=4b86243d9f19c0718985caae923cfe66a0d266aa
ARG AMPLIFIER_HOOKS_APPROVAL_COMMIT=c149f1e09757567d0dfc82a83bf21ac274a2061d
COPY docker/runtime/prepare-amplifier-modes.py /opt/prepare-amplifier-modes.py
COPY docker/runtime/prepare-amplifier-profile.py /opt/prepare-amplifier-profile.py
RUN git clone --filter=blob:none https://github.com/microsoft/amplifier-bundle-modes /opt/amplifier-modes \
 && git -C /opt/amplifier-modes checkout --detach "${AMPLIFIER_MODES_COMMIT}" \
 && git -C /opt/amplifier-modes rev-parse HEAD | grep -Fx "${AMPLIFIER_MODES_COMMIT}" \
 && git clone --filter=blob:none https://github.com/microsoft/amplifier-module-hooks-approval /opt/amplifier-hooks-approval \
 && git -C /opt/amplifier-hooks-approval checkout --detach "${AMPLIFIER_HOOKS_APPROVAL_COMMIT}" \
 && git -C /opt/amplifier-hooks-approval rev-parse HEAD | grep -Fx "${AMPLIFIER_HOOKS_APPROVAL_COMMIT}" \
 && /opt/uv/bin/uv pip install --python /opt/amplifier-src/.venv/bin/python --no-deps \
      /opt/amplifier-modes/modules/hooks-mode /opt/amplifier-modes/modules/tool-mode /opt/amplifier-hooks-approval \
 && /opt/amplifier-src/.venv/bin/python /opt/prepare-amplifier-modes.py \
 && rm -rf /opt/amplifier-modes/.git /opt/amplifier-hooks-approval/.git \
 && /opt/amplifier-src/.venv/bin/python -c 'import importlib.metadata as m; assert m.version("amplifier-module-hooks-mode") == "1.0.0"; assert m.version("amplifier-module-tool-mode") == "1.0.0"; assert m.version("amplifier-module-hooks-approval") == "0.1.0"'

# FreshClaude/Kilroy run inside the soul host, so their JS SDK bridge and its
# pinned dependency must be part of the workload image rather than resolved
# through a web-server worktree path.
COPY --from=claude-sidecar /opt/freshell-claude-sidecar/ /opt/freshell-claude-sidecar/
COPY --from=mcp-runtime /opt/freshell-mcp/ /opt/freshell-mcp/
# The MCP server reports the same application version as the ordinary entry.
COPY package.json /opt/package.json

WORKDIR /workspace
CMD ["/bin/bash"]
