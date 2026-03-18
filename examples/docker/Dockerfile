# Minimal Docker image demonstrating that server extensions work
# through freshell's HTTP proxy without exposing extension ports.
#
# Build:  docker build -t freshell-docker-test -f examples/docker/Dockerfile .
# Run:    docker run --rm -p 3001:3001 freshell-docker-test
# Open:   The startup URL (with token) is printed to stdout
#
# Only port 3001 is exposed. Server extensions (status-dashboard,
# live-counter) allocate dynamic ports *inside* the container, but
# their iframes load through /api/proxy/http/:port/ on port 3001,
# so the browser never needs direct access to those ports.

FROM node:24-slim

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts 2>/dev/null; exit 0
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Install example extensions and configure network access
RUN mkdir -p /root/.freshell/extensions && \
    ln -s /app/examples/extensions/status-dashboard /root/.freshell/extensions/status-dashboard && \
    ln -s /app/examples/extensions/live-counter /root/.freshell/extensions/live-counter && \
    ln -s /app/examples/extensions/notepad /root/.freshell/extensions/notepad && \
    echo '{"version":1,"settings":{"network":{"configured":true,"host":"0.0.0.0"}}}' > /root/.freshell/config.json

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/server/index.js"]
