FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

FROM deps AS api-build
COPY packages/api/tsconfig.json packages/api/tsconfig.json
COPY packages/api/src packages/api/src
COPY packages/api/db packages/api/db
RUN npm run build:api

FROM deps AS web-build
COPY packages/web packages/web
RUN npm run build:web

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM golang:1.25.13-alpine AS agent-builder
# Display version defaults to 'dev' unless an explicit AGENT_VERSION is supplied.
# Deployment builds compute content identity using the Go CLI and ignore any
# AGENT_BUILD_ID override.
ARG AGENT_VERSION=dev
ARG AGENT_BUILD_ID
WORKDIR /src
COPY packages/agent/go.mod packages/agent/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY packages/agent/ .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /usr/local/bin/agent-build-id ./cmd/agent-build-id && \
    BUILD_ID=$(/usr/local/bin/agent-build-id --root .) && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -buildvcs=false \
    -ldflags "-X github.com/vps-manager/agent/internal/version.Value=${AGENT_VERSION} -X github.com/vps-manager/agent/internal/version.Build=${BUILD_ID}" \
    -o /out/vps-agent-linux-amd64 ./cmd/vps-agent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -buildvcs=false \
    -ldflags "-X github.com/vps-manager/agent/internal/version.Value=${AGENT_VERSION} -X github.com/vps-manager/agent/internal/version.Build=${BUILD_ID}" \
    -o /out/vps-updater-linux-amd64 ./cmd/vps-updater && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -buildvcs=false \
    -o /out/host-pty-linux-amd64 ./cmd/host-pty && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -buildvcs=false \
    -o /out/local-agent-rotator-linux-amd64 ./cmd/local-agent-rotator && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -buildvcs=false \
    -o /out/host-files-linux-amd64 ./cmd/host-files && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -buildvcs=false \
    -o /out/ai-executor-linux-amd64 ./cmd/ai-executor && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -buildvcs=false \
    -o /out/ai-host-helper-linux-amd64 ./cmd/ai-host-helper
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    BUILD_ID=$(/usr/local/bin/agent-build-id --root .) && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
    -trimpath -buildvcs=false \
    -ldflags "-X github.com/vps-manager/agent/internal/version.Value=${AGENT_VERSION} -X github.com/vps-manager/agent/internal/version.Build=${BUILD_ID}" \
    -o /out/vps-agent-linux-arm64 ./cmd/vps-agent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
    -trimpath -buildvcs=false \
    -ldflags "-X github.com/vps-manager/agent/internal/version.Value=${AGENT_VERSION} -X github.com/vps-manager/agent/internal/version.Build=${BUILD_ID}" \
    -o /out/vps-updater-linux-arm64 ./cmd/vps-updater
# Go trimpath builds do not retain linker flags as searchable build metadata.
# Package checksum-bound identity for the API's existing companion reader.
RUN BUILD_ID=$(/usr/local/bin/agent-build-id --root .) && \
    printf '%s' "$AGENT_VERSION" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$' && \
    for arch in amd64 arm64; do \
        binary="/out/vps-agent-linux-$arch"; \
        sha=$(sha256sum "$binary" | cut -d ' ' -f 1) && \
        printf '{"os":"linux","arch":"%s","version":"%s","buildId":"%s","sha256":"%s"}\n' \
            "$arch" "$AGENT_VERSION" "$BUILD_ID" "$sha" > "$binary.json" || exit 1; \
    done
RUN mkdir -p /out/ai-rootfs/bin /out/ai-rootfs/usr/bin /out/ai-rootfs/dev /out/ai-rootfs/proc /out/ai-rootfs/sys /out/ai-rootfs/tmp /out/ai-rootfs/etc && \
    chmod 1777 /out/ai-rootfs/tmp && \
    cp /bin/busybox /out/ai-rootfs/bin/busybox && \
    chmod 0755 /out/ai-rootfs/bin/busybox && \
    for tool in sh ps cat ls sleep pwd echo wc head tail grep du stat dd md5sum sha256sum true false date env split uniq cut awk find sort tr yes readlink basename dirname mktemp bzip2 gzip mkdir touch rm cp mv ln chmod chown test "["; do \
        ln -sf /bin/busybox /out/ai-rootfs/bin/$tool; \
    done && \
    tar -czf /out/ai-rootfs-linux-amd64.tar.gz -C /out/ai-rootfs . && \
    ROOTFS_SHA=$(sha256sum /out/ai-rootfs-linux-amd64.tar.gz | awk '{print $1}') && \
    echo "{\"version\":1,\"rootfsSha256\":\"$ROOTFS_SHA\",\"files\":[" > /out/ai-rootfs-linux-amd64.manifest.json && \
    first=1; for f in /out/ai-rootfs/bin/*; do \
        [ $first -eq 0 ] && echo "," >> /out/ai-rootfs-linux-amd64.manifest.json; \
        first=0; \
        rel="/bin/$(basename $f)"; \
        fsha=$(sha256sum $f | awk '{print $1}'); \
        echo "  {\"path\":\"$rel\",\"sha256\":\"$fsha\",\"mode\":493}" >> /out/ai-rootfs-linux-amd64.manifest.json; \
    done && \
    echo "]}" >> /out/ai-rootfs-linux-amd64.manifest.json && \
    mkdir -p /out/ai-profiles && \
    cp profiles/nginx.json /out/ai-profiles/nginx.json
FROM node:24-alpine AS api-runtime
ENV NODE_ENV=production \
    AGENT_BINARY_PATH=/app/agent/vps-agent-linux-amd64 \
    LOCAL_AGENT_ROTATION_HELPER=/usr/local/bin/local-agent-rotation-client \
    LOCAL_AGENT_ROTATION_SOCKET=/var/run/flexserver/agent-rotation.sock
WORKDIR /app
# openssh-client provides ssh-keyscan used for SSH host key provisioning
RUN apk add --no-cache openssh-client
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=api-build --chown=app:app /app/package.json ./package.json
COPY --from=api-build --chown=app:app /app/dist ./dist
COPY --from=api-build --chown=app:app /app/packages/api/db ./db
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/vps-agent-linux-amd64 /app/agent/vps-agent-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/vps-updater-linux-amd64 /app/agent/vps-updater-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/vps-agent-linux-arm64 /app/agent/vps-agent-linux-arm64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/vps-updater-linux-arm64 /app/agent/vps-updater-linux-arm64
COPY --from=agent-builder --chown=app:app --chmod=0644 /out/vps-agent-linux-amd64.json /app/agent/vps-agent-linux-amd64.json
COPY --from=agent-builder --chown=app:app --chmod=0644 /out/vps-agent-linux-arm64.json /app/agent/vps-agent-linux-arm64.json
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/host-pty-linux-amd64 /app/agent/host-pty-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/local-agent-rotator-linux-amd64 /app/agent/local-agent-rotator-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/host-files-linux-amd64 /app/agent/host-files-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/ai-executor-linux-amd64 /app/agent/ai-executor-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0755 /out/ai-host-helper-linux-amd64 /app/agent/ai-host-helper-linux-amd64
COPY --from=agent-builder --chown=app:app --chmod=0644 /out/ai-rootfs-linux-amd64.tar.gz /app/agent/ai-rootfs-linux-amd64.tar.gz
COPY --from=agent-builder --chown=app:app --chmod=0644 /out/ai-rootfs-linux-amd64.manifest.json /app/agent/ai-rootfs-linux-amd64.manifest.json
COPY --from=agent-builder --chown=app:app /out/ai-profiles /app/agent/ai-profiles
COPY scripts/install/install-host-files.sh /app/scripts/install-host-files.sh
COPY --chown=app:app --chmod=0755 scripts/install/install-fleet-updater.sh /app/scripts/install/install-fleet-updater.sh
COPY scripts/install/install-updater.sh /app/scripts/install/install-updater.sh
RUN ln -s /app/agent/local-agent-rotator-linux-amd64 /usr/local/bin/local-agent-rotation-client && \
    ln -s /app/agent/local-agent-rotator-linux-amd64 /usr/local/bin/flexserver-local-agent-rotator
RUN mkdir -p /app/data /app/private && chown -R app:app /app/data /app/private
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

FROM nginx:1.30.5-alpine3.24 AS web-runtime
RUN apk upgrade --no-cache libcrypto3 libssl3 openssl
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/public /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
