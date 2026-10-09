# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM golang:1-bookworm AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
RUN go build -trimpath -ldflags="-s -w" -o /out/wallet-api ./cmd/wallet-api

# ---- runtime stage ----------------------------------------------------------
# distroless static, non-root, no shell.
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

WORKDIR /app
COPY --from=build /out/wallet-api /app/wallet-api

USER nonroot:nonroot

ENV APP_ENV=production \
    HTTP_ADDR=:8080 \
    METRICS_ADDR=:9090

EXPOSE 8080 9090

# distroless has no shell, so no HEALTHCHECK CMD curl; rely on the
# orchestrator's HTTP probe against /healthz and /readyz instead.

ENTRYPOINT ["/app/wallet-api"]
