package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestWordlistHas2048Words(t *testing.T) {
	if BIP39WordCount() != 2048 {
		t.Fatalf("want 2048 words, got %d", BIP39WordCount())
	}
}

func newTestLogger(buf *bytes.Buffer) *slog.Logger {
	base := slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(NewRedactingHandler(base))
}

func TestRedactsDeniedKeys(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestLogger(&buf)
	logger.Info("user did something",
		slog.String("mnemonic", "abandon abandon abandon"),
		slog.String("Password", "hunter2"),
		slog.String("Authorization", "Bearer abc"),
		slog.String("X-Csrf-Token", "abc"),
		slog.String("cookie", "session=abc"),
		slog.String("pin", "1234"),
		slog.String("private_key", "0xdead"),
		slog.String("safe_field", "hello"),
	)
	out := buf.String()
	for _, denied := range []string{"mnemonic", "Password", "hunter2", "Authorization", "Bearer abc", "X-Csrf-Token", "cookie", "session=abc", "pin", "1234", "private_key", "0xdead"} {
		if strings.Contains(out, denied) {
			t.Errorf("log output must not contain %q, got: %s", denied, out)
		}
	}
	if !strings.Contains(out, "safe_field") {
		t.Errorf("expected safe_field to survive redaction, got: %s", out)
	}
}

func TestRedactsNestedGroups(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestLogger(&buf)
	logger.Info("nested",
		slog.Group("request",
			slog.String("token", "secret-value"),
			slog.String("path", "/v1/me"),
		),
	)
	out := buf.String()
	if strings.Contains(out, "secret-value") {
		t.Errorf("nested secret leaked: %s", out)
	}
	if !strings.Contains(out, "/v1/me") {
		t.Errorf("expected safe nested field to survive: %s", out)
	}
}

func TestMasksBIP39RunInMessage(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestLogger(&buf)
	// 12-word official BIP-39 test vector phrase (all valid english words).
	phrase := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	logger.Info("accidental phrase log: " + phrase)

	var decoded map[string]any
	if err := json.Unmarshal(buf.Bytes(), &decoded); err != nil {
		t.Fatalf("failed to decode json log line: %v", err)
	}
	msg, _ := decoded["msg"].(string)
	if strings.Contains(msg, "abandon abandon") {
		t.Errorf("bip39 phrase leaked in message: %s", msg)
	}
	if !strings.Contains(msg, "[REDACTED]") {
		t.Errorf("expected [REDACTED] marker, got: %s", msg)
	}
}

func TestMasksBIP39RunInAttrValue(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestLogger(&buf)
	phrase := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	logger.Info("body", slog.String("raw_body", phrase))
	out := buf.String()
	if strings.Contains(out, "abandon abandon abandon abandon") {
		t.Errorf("bip39 phrase leaked in attr value: %s", out)
	}
}

func TestDoesNotMaskShortWordRuns(t *testing.T) {
	// 11 words should NOT be masked (below the 12-word threshold), to avoid
	// destroying legitimate log content.
	var buf bytes.Buffer
	logger := newTestLogger(&buf)
	elevenWords := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"
	logger.Info(elevenWords)
	out := buf.String()
	if strings.Contains(out, "[REDACTED]") {
		t.Errorf("did not expect redaction for an 11-word run: %s", out)
	}
}

func TestNewBuildsWorkingLogger(t *testing.T) {
	l := New(slog.LevelInfo)
	if l == nil {
		t.Fatal("expected non-nil logger")
	}
	ctx := WithRequestID(context.Background(), "req-1")
	if got := RequestIDFromContext(ctx); got != "req-1" {
		t.Fatalf("got %q", got)
	}
}
