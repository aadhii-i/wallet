package rpc

import "testing"

// Whitebox test of the circuit breaker state machine itself (package-internal
// so it can reach unexported fields/methods directly).
func TestCircuitBreakerStateMachine(t *testing.T) {
	p := newProvider("test", "http://example.invalid", nil)

	if !p.allowRequest() {
		t.Fatal("expected a fresh circuit to allow requests")
	}

	for i := 0; i < consecutiveFailuresToOpen; i++ {
		p.recordFailure()
	}
	if p.allowRequest() {
		t.Fatal("expected the circuit to be open after consecutive failures")
	}
	if !p.isOpen() {
		t.Fatal("expected isOpen() to report true")
	}

	// Simulate the open window elapsing by rewinding openedAt.
	p.mu.Lock()
	p.openedAt = p.openedAt.Add(-openDuration - 1)
	p.mu.Unlock()

	if !p.allowRequest() {
		t.Fatal("expected the circuit to half-open and allow a probe request after the open duration elapses")
	}

	p.recordSuccess()
	if !p.allowRequest() {
		t.Fatal("expected the circuit to be closed again after a successful probe")
	}
}
