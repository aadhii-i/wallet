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

// prodEnv sets a production configuration that is complete except for what
// a test changes.
func prodEnv(t *testing.T) {
	t.Helper()
	for k, v := range map[string]string{
		"APP_ENV": "production", "STORE": "postgres", "DATABASE_URL": "postgres://db/x",
		"CSRF_KEY": strings.Repeat("c", 32), "IP_HASH_KEY": strings.Repeat("i", 32),
		"JWT_SIGNING_KEY": "set (parsed by the key manager at startup)",
		"KEY_MANAGER":     "", "DEV_CREDENTIAL_RATE_BURST": "", "BTC_ESPLORA_URL": "", "BTC_NETWORK": "",
	} {
		t.Setenv(k, v)
	}
}

func TestKeyManagerDefaultsByEnvironment(t *testing.T) {
	prodEnv(t)
	cfg, _ := Load()
	if cfg.KeyManager != KeyManagerEnv {
		t.Fatalf("production default %q, want env", cfg.KeyManager)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("complete production config refused: %v", err)
	}
	t.Setenv("APP_ENV", "development")
	t.Setenv("JWT_SIGNING_KEY", "")
	if cfg, _ = Load(); cfg.KeyManager != KeyManagerLocalDev {
		t.Fatalf("development default %q, want localdev", cfg.KeyManager)
	}
	// Development may opt in to the env key manager (same keys as production).
	t.Setenv("KEY_MANAGER", "env")
	t.Setenv("JWT_SIGNING_KEY", "x")
	if cfg, _ = Load(); cfg.KeyManager != KeyManagerEnv || cfg.Validate() != nil {
		t.Fatalf("development with KEY_MANAGER=env: %q %v", cfg.KeyManager, cfg.Validate())
	}
}

func TestProductionRefusesLocalDevKeysAndMissingSigningKey(t *testing.T) {
	prodEnv(t)
	t.Setenv("KEY_MANAGER", "localdev")
	cfg, _ := Load()
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "KEY_MANAGER=localdev") {
		t.Fatalf("production accepted localdev keys: %v", err)
	}
	prodEnv(t)
	t.Setenv("JWT_SIGNING_KEY", "")
	cfg, _ = Load()
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "JWT_SIGNING_KEY is required") {
		t.Fatalf("production started without a signing key: %v", err)
	}
	t.Setenv("KEY_MANAGER", "kms")
	t.Setenv("JWT_SIGNING_KEY", "x")
	cfg, _ = Load()
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "KEY_MANAGER") {
		t.Fatalf("unknown key manager accepted: %v", err)
	}
}

// Validation errors name variables, never their values.
func TestValidationErrorsDoNotEchoSecrets(t *testing.T) {
	prodEnv(t)
	t.Setenv("KEY_MANAGER", "localdev")
	t.Setenv("JWT_SIGNING_KEY", "SUPER-SECRET-VALUE")
	cfg, _ := Load()
	if err := cfg.Validate(); err == nil || strings.Contains(err.Error(), "SUPER-SECRET-VALUE") {
		t.Fatalf("%v", err)
	}
}

// Production may hold relayer keys for public testnets only, and only with
// shared wallets enabled; mainnets and local chains are refused by chain id.
func TestProductionRelayerKeysTestnetsOnly(t *testing.T) {
	const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" // public Anvil fixture
	prodEnv(t)
	t.Setenv("ENABLE_SHARED_WALLETS", "true")
	for _, id := range []string{"11155111", "84532", "421614", "80002"} {
		t.Setenv("RELAYER_PRIVATE_KEY_"+id, key)
	}
	cfg, _ := Load()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("testnet relayer keys refused in production: %v", err)
	}
	for _, id := range []string{"1", "8453", "42161", "137", "31337", "296", "999999"} {
		t.Run(id, func(t *testing.T) {
			t.Setenv("RELAYER_PRIVATE_KEY_"+id, key)
			cfg, _ := Load()
			err := cfg.Validate()
			if err == nil || !strings.Contains(err.Error(), "RELAYER_PRIVATE_KEY_"+id+" is refused") {
				t.Fatalf("chain %s accepted in production: %v", id, err)
			}
			if strings.Contains(err.Error(), key[2:]) {
				t.Fatal("validation error echoes the relayer key")
			}
		})
	}
	t.Setenv("ENABLE_SHARED_WALLETS", "false")
	cfg, _ = Load()
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "ENABLE_SHARED_WALLETS") {
		t.Fatalf("relayer keys without shared wallets accepted: %v", err)
	}
	// Development is unchanged: any chain is accepted by config (main.go then
	// ignores keys for non-execution chains).
	t.Setenv("APP_ENV", "development")
	t.Setenv("RELAYER_PRIVATE_KEY_1", key)
	cfg, _ = Load()
	if err := cfg.Validate(); err != nil && strings.Contains(err.Error(), "RELAYER_PRIVATE_KEY") {
		t.Fatalf("development refused relayer keys: %v", err)
	}
}
