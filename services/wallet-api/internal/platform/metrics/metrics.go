// Package metrics defines the Prometheus metrics exposed by wallet-api on
// METRICS_ADDR (separate from the main API port).
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	HTTPRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_server_request_duration_seconds",
		Help: "HTTP server request duration in seconds.",
	}, []string{"route", "method", "status"})

	RPCUpstreamDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "rpc_upstream_request_duration_seconds",
		Help: "Upstream JSON-RPC request duration in seconds.",
	}, []string{"chain_id", "provider", "method"})

	RPCUpstreamErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "rpc_upstream_errors_total",
		Help: "Upstream JSON-RPC errors.",
	}, []string{"chain_id", "provider", "method", "kind"})

	RPCProviderHealthy = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_provider_healthy",
		Help: "1 if the provider is currently considered healthy.",
	}, []string{"chain_id", "provider"})

	RPCProviderHeadLag = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_provider_head_lag_blocks",
		Help: "Blocks behind the best known head for this chain.",
	}, []string{"chain_id", "provider"})

	TxFinalStatusTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tx_final_status_total",
		Help: "Count of tracked transactions reaching a final status.",
	}, []string{"network", "status"})

	TxTimeToConfirm = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "tx_time_to_confirm_seconds",
		Help: "Time from tracking to confirmation.",
	}, []string{"network"})

	AuthAttemptsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "auth_attempts_total",
		Help: "Authentication attempts by kind and outcome.",
	}, []string{"kind", "outcome"})

	RefreshTokenReuseTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "refresh_token_reuse_total",
		Help: "Detected refresh token reuse events.",
	})
)

// Handler returns the /metrics HTTP handler.
func Handler() http.Handler {
	return promhttp.Handler()
}
