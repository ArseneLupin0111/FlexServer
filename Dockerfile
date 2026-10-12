FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM golang:1.25.13-alpine AS agent-builder
# Immutable build identity, injected by CI (--build-arg AGENT_VERSION=...
# --build-arg AGENT_BUILD_ID=<full git SHA>); defaults mark unknown identity
# so a local unparameterized build never advertises a release as current.
ARG AGENT_VERSION=dev
ARG AGENT_BUILD_ID
WORKDIR /src
COPY packages/agent/go.mod ./
RUN go mod download
COPY packages/agent/ .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-X github.com/vps-manager/agent/internal/version.Value=${AGENT_VERSION} -X github.com/vps-manager/agent/internal/version.Build=${AGENT_BUILD_ID}" \
    -o /out/vps-agent-linux-amd64 ./cmd/vps-agent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-X github.com/vps-manager/agent/internal/version.Value=${AGENT_VERSION} -X github.com/vps-manager/agent/internal/version.Build=${AGENT_BUILD_ID}" \
    -o /out/vps-updater-linux-amd64 ./cmd/vps-updater
FROM node:24-alpine AS api-runtime
ENV NODE_ENV=production \
    AGENT_BINARY_PATH=/app/agent/vps-agent-linux-amd64
WORKDIR /app
# openssh-client provides ssh-keyscan used for SSH host key provisioning
RUN apk add --no-cache openssh-client
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/packages/api/db ./db
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/vps-agent-linux-amd64 /app/agent/vps-agent-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/vps-updater-linux-amd64 /app/agent/vps-updater-linux-amd64
RUN mkdir -p /app/data /app/private && chown -R app:app /app/data /app/private
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

FROM nginx:1.30.5-alpine3.24 AS web-runtime
RUN apk upgrade --no-cache libcrypto3 libssl3 openssl
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/public /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
