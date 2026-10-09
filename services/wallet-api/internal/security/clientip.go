package security

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP resolves the client IP to use as a rate-limit key and as the
// input to HashIP. It always starts from the TCP peer address
// (r.RemoteAddr, host only -- never host:port, so a single client can't get
// a fresh bucket per ephemeral source port) and only ever consults
// X-Forwarded-For if that peer is itself inside trustedProxies. When
// trusted, it walks X-Forwarded-For from the right and returns the first
// entry that is NOT itself a trusted proxy (the "rightmost untrusted hop"),
// which is the one hop a chain of trusted proxies could not have forged.
// An untrusted caller can put anything it wants in X-Forwarded-For, so it
// must never be honoured unless the immediate peer is a proxy we operate.
func ClientIP(r *http.Request, trustedProxies []*net.IPNet) string {
	peer := hostOnly(r.RemoteAddr)
	if len(trustedProxies) == 0 || !ipInNets(peer, trustedProxies) {
		return peer
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return peer
	}
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if candidate == "" {
			continue
		}
		if !ipInNets(candidate, trustedProxies) {
			return candidate
		}
	}
	return peer
}

func hostOnly(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		// remoteAddr had no port (e.g. a unix socket or test dial string);
		// use it as-is.
		return remoteAddr
	}
	return host
}

func ipInNets(ipStr string, nets []*net.IPNet) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
