package config

import (
	"strings"
	"testing"
)

func TestDevCredentialBurstRefusedInProduction(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("DEV_CREDENTIAL_RATE_BURST", "200")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "DEV_CREDENTIAL_RATE_BURST") {
		t.Fatalf("production accepted the dev override: %v", err)
	}
}

func TestDevCredentialBurstDefaultsOff(t *testing.T) {
	t.Setenv("DEV_CREDENTIAL_RATE_BURST", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DevCredentialBurst != 0 {
		t.Fatalf("default burst %d", cfg.DevCredentialBurst)
	}
	t.Setenv("DEV_CREDENTIAL_RATE_BURST", "-5")
	if cfg, _ = Load(); cfg.DevCredentialBurst != 0 {
		t.Fatalf("negative accepted: %d", cfg.DevCredentialBurst)
	}
}
