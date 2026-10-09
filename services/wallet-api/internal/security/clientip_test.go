package security

import (
	"net"
	"net/http"
	"testing"
)

func mustCIDR(t *testing.T, s string) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestClientIPIgnoresXFFFromUntrustedPeer(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "203.0.113.5:54321"
	r.Header.Set("X-Forwarded-For", "10.0.0.1") // attacker-supplied spoof

	got := ClientIP(r, nil)
	if got != "203.0.113.5" {
		t.Fatalf("expected the raw peer IP when there are no trusted proxies, got %q", got)
	}

	// Even with a trusted-proxies list configured, an untrusted peer's XFF
	// must still be ignored.
	trusted := []*net.IPNet{mustCIDR(t, "10.0.0.0/8")}
	got = ClientIP(r, trusted)
	if got != "203.0.113.5" {
		t.Fatalf("expected the raw peer IP when the peer itself is not trusted, got %q", got)
	}
}

func TestClientIPUsesRightmostUntrustedHopFromTrustedProxy(t *testing.T) {
	trusted := []*net.IPNet{mustCIDR(t, "10.0.0.0/8")}

	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:443" // our trusted load balancer
	// Client -> (public internet, spoofable) -> our LB. Only the hop
	// immediately before our infrastructure is trustworthy.
	r.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.2")

	got := ClientIP(r, trusted)
	if got != "198.51.100.7" {
		t.Fatalf("expected the rightmost untrusted hop, got %q", got)
	}
}

func TestClientIPFallsBackToPeerWhenXFFIsAllTrusted(t *testing.T) {
	trusted := []*net.IPNet{mustCIDR(t, "10.0.0.0/8")}
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-For", "10.0.0.5, 10.0.0.2")

	got := ClientIP(r, trusted)
	if got != "10.0.0.1" {
		t.Fatalf("expected fallback to the peer address, got %q", got)
	}
}

func TestClientIPStripsPortFromPeer(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "203.0.113.9:12345"
	got := ClientIP(r, nil)
	if got != "203.0.113.9" {
		t.Fatalf("expected host without port, got %q", got)
	}
}
