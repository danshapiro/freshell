# syntax=docker/dockerfile:1.7
# Copy exact Node 22 bits from the official Node image into the Ubuntu 24.04
# runtime ABI used to build freshell-session-host. Both inputs are digest-pinned.
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS node-source

FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
ARG CLAUDE_CODE_VERSION=2.1.263
ARG OPENCODE_VERSION=1.18.21
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=node-source /usr/local/ /usr/local/
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git openssh-client procps python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
 && node --version | grep -Fx 'v22.23.2' \
 && claude --version | grep -F "${CLAUDE_CODE_VERSION}" \
 && opencode --version | grep -Fx "${OPENCODE_VERSION}" \
 && /lib/x86_64-linux-gnu/libc.so.6 | grep -F '2.39'

WORKDIR /workspace
CMD ["/bin/bash"]
