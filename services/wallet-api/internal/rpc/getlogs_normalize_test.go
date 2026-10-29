package rpc_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/qdwallet/wallet-api/internal/rpc"
)

// The proxy rebuilds an eth_getLogs filter from its own struct instead of
// forwarding the client's bytes, so a caller must not be able to make the
// upstream see a wider block range than the one wallet-api validated.
//
// encoding/json matches struct fields case-insensitively and assigns in document
// order, so a duplicate "ToBlock" sitting beside "toBlock" silently won the value
// that got validated. These tests pin the explicit rejection that replaced that
// accident, and the normalisation that was always intended.

func newLogsUpstream(t *testing.T, seenLogs *string) *fakeUpstream {
	t.Helper()
	return newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		if method == "eth_getLogs" {
			*seenLogs = string(params)
			return []any{}, nil
		}
		// Provider health probes (eth_blockNumber) must not be mistaken for a
		// forwarded filter.
		return "0x1", nil
	})
}

func startProxy(t *testing.T, up *fakeUpstream) *httptest.Server {
	t.Helper()
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "only", URL: up.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	t.Cleanup(srv.Close)
	return srv
}

func TestGetLogsRejectsCaseVariantDuplicateRangeKeys(t *testing.T) {
	var seenLogs string
	srv := startProxy(t, newLogsUpstream(t, &seenLogs))

	// A legitimate small range (0x0-0x64) plus case-variant duplicates carrying a
	// huge range. The wide values must never be validated, adopted, or forwarded.
	body := `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x64","FromBlock":"0x0","ToBlock":"0xFFFFFF","address":"0xabc"}]}`
	resp, respBody := postRPC(t, srv, 31337, body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("proxy returned HTTP %d: %s", resp.StatusCode, respBody)
	}
	if seenLogs != "" {
		t.Fatalf("upstream must not be reached with an ambiguous filter, saw: %s", seenLogs)
	}
	if !containsAll(string(respBody), `"code":-32602`, "duplicate keys") {
		t.Fatalf("expected a -32602 duplicate-keys rejection, got: %s", respBody)
	}
}

func TestGetLogsForwardsCanonicalRangeAndDropsUnknownKeys(t *testing.T) {
	var seenLogs string
	srv := startProxy(t, newLogsUpstream(t, &seenLogs))

	// 0x00 canonicalises to 0x0, and blockHash is not a key wallet-api
	// understands, so it must not survive the rebuild.
	body := `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x00","toBlock":"0x64","address":"0xabc","blockHash":"0xdeadbeef"}]}`
	resp, respBody := postRPC(t, srv, 31337, body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("proxy returned HTTP %d: %s", resp.StatusCode, respBody)
	}
	if seenLogs == "" {
		t.Fatalf("expected the upstream to be called, proxy replied: %s", respBody)
	}
	if !containsAll(seenLogs, `"fromBlock":"0x0"`, `"toBlock":"0x64"`, `"address":"0xabc"`) {
		t.Fatalf("expected the canonicalised range and the opaque address, got: %s", seenLogs)
	}
	if containsAny(seenLogs, "blockHash", "0xdeadbeef") {
		t.Fatalf("expected unrecognised keys to be dropped, got: %s", seenLogs)
	}
}

func TestGetLogsRejectsRangeAboveCap(t *testing.T) {
	var seenLogs string
	srv := startProxy(t, newLogsUpstream(t, &seenLogs))

	body := `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0xBB8"}]}`
	resp, respBody := postRPC(t, srv, 31337, body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("proxy returned HTTP %d: %s", resp.StatusCode, respBody)
	}
	if seenLogs != "" {
		t.Fatalf("over-cap range must not reach the upstream, saw: %s", seenLogs)
	}
	if !contains(string(respBody), "2000 blocks") {
		t.Fatalf("expected the range cap message, got: %s", respBody)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !contains(s, sub) {
			return false
		}
	}
	return true
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if contains(s, sub) {
			return true
		}
	}
	return false
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
