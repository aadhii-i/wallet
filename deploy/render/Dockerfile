# syntax=docker/dockerfile:1
#
# One image, one origin: wallet-api serving the web app's static export
# (WEB_DIR) next to the API. Used for the Render free-tier beta, where the web
# app and the API cannot share a registrable domain any other way, so
# SameSite=Strict session cookies need them on the same origin.
#
# Build context: the repository root (Render: Root Directory empty,
# Dockerfile Path ./deploy/render/Dockerfile). See docs/operations/render-deploy.md.

# ---- web: static export ------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
# Same origin: an empty API URL makes the app call /v1/... on its own origin,
# and the generated CSP's connect-src 'self' covers it. Local networks (Anvil)
# are never part of a deployed build.
ARG NEXT_PUBLIC_ENABLE_SHARED_WALLETS=true
ENV NEXT_PUBLIC_API_URL= \
    NEXT_PUBLIC_ENABLE_LOCAL_NETWORKS=false \
    NEXT_PUBLIC_ENABLE_SHARED_WALLETS=${NEXT_PUBLIC_ENABLE_SHARED_WALLETS} \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @qd/web build && test -f apps/web/out/_headers

# ---- api ---------------------------------------------------------------------
FROM golang:1-bookworm AS api
WORKDIR /src
COPY services/wallet-api/go.mod services/wallet-api/go.sum ./
RUN go mod download
COPY services/wallet-api/ .
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
RUN go build -trimpath -ldflags="-s -w" -o /out/wallet-api ./cmd/wallet-api

# ---- runtime: distroless, non-root, no shell -----------------------------------
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=api /out/wallet-api /app/wallet-api
COPY --from=web /src/apps/web/out /app/web
USER nonroot:nonroot
ENV APP_ENV=production \
    HTTP_ADDR=:8080 \
    METRICS_ADDR=127.0.0.1:9090 \
    WEB_DIR=/app/web
EXPOSE 8080
ENTRYPOINT ["/app/wallet-api"]
