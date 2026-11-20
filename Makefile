# QD Wallet developer commands. Requires: pnpm (via corepack), Go 1.26+, Docker.
PNPM := corepack pnpm@9.15.0
API  := services/wallet-api
# Anvil's public test account #1: pays gas to submit shared-wallet executions on
# local Anvil only (the API refuses relayer keys in production).
ANVIL_RELAYER_KEY := 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

# Server-side secrets (e.g. EVM_RPC_11155111) for `make api`. Gitignored.
-include .env
# Secrets reach the API through the environment, never on the echoed command
# line (make prints recipes): only these .env values are exported.
# Feature flags are exported only when .env sets them: an unset flag must stay
# unset (not empty), so apps/web/.env.local can still provide the web flag.
ifdef ENABLE_SHARED_WALLETS
export ENABLE_SHARED_WALLETS
endif
ifdef NEXT_PUBLIC_ENABLE_SHARED_WALLETS
export NEXT_PUBLIC_ENABLE_SHARED_WALLETS
endif
export EVM_RPC_11155111
export RELAYER_PRIVATE_KEY_11155111
export GAS_LOW_BALANCE_WEI_11155111
# Further server-side settings, exported only when .env sets them: the rollup
# testnets (Base Sepolia, Arbitrum Sepolia, Polygon Amoy), Bitcoin and Hedera.
SERVER_ENV := $(foreach c,84532 421614 80002,EVM_RPC_$(c) RELAYER_PRIVATE_KEY_$(c) GAS_LOW_BALANCE_WEI_$(c) HISTORY_PROVIDER_$(c)) \
	HISTORY_PROVIDER_11155111 BTC_ESPLORA_URL BTC_NETWORK BTC_FEE_FLOOR_SAT_VB BTC_MAX_FEE_SAT_VB HEDERA_MIRROR_URL
$(foreach v,$(SERVER_ENV),$(if $(filter-out undefined,$(origin $(v))),$(eval export $(v))))

.PHONY: help install up down anvil api web build test test-ts test-go e2e e2e-shared lint typecheck fund contracts relayer-status

help:        ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/ —/'

install:     ## Install JS dependencies
	$(PNPM) install

up:          ## Start local stack (postgres, redis, anvil, api, observability)
	docker compose up -d --build

down:        ## Stop local stack
	docker compose down

anvil:       ## Run Anvil on the host (no Docker)
	anvil --port 8545 --chain-id 31337 --block-time 1

api:         ## Run wallet-api on the host (in-memory store persisted to .data/, host Anvil, Sepolia from .env)
	cd $(API) && CGO_ENABLED=0 APP_ENV=development STORE=memory STORE_SNAPSHOT=$(CURDIR)/.data/dev-store.json COOKIE_SECURE=false DEV_CREDENTIAL_RATE_BURST=200 ALLOWED_ORIGINS=http://localhost:3000 EVM_RPC_31337=anvil=http://127.0.0.1:8545 RELAYER_PRIVATE_KEY_31337=$(ANVIL_RELAYER_KEY) PRICE_PROVIDER=static go run ./cmd/wallet-api

web:         ## Run the web app in dev mode (server-side RPC URLs and relayer keys are not passed to it)
	env $(foreach v,EVM_RPC_11155111 RELAYER_PRIVATE_KEY_11155111 GAS_LOW_BALANCE_WEI_11155111 $(SERVER_ENV),-u $(v)) $(PNPM) --filter @qd/web dev

build:       ## Build everything
	$(PNPM) -r --filter "./packages/*" typecheck
	$(PNPM) --filter @qd/web build
	cd $(API) && CGO_ENABLED=0 go build -o bin/wallet-api ./cmd/wallet-api

test: test-ts test-go ## Run all unit tests

test-ts:     ## TypeScript unit tests (+ Anvil integration when ANVIL_RPC_URL is set)
	$(PNPM) -r test

test-go:     ## Go unit tests
	cd $(API) && CGO_ENABLED=0 go vet ./... && CGO_ENABLED=0 go test ./...

e2e:         ## Playwright E2E (needs `make build` and Anvil running)
	cd apps/web && ANVIL_RPC_URL=http://127.0.0.1:8545 npx playwright test

contracts:   ## Build Solidity (Foundry) and regenerate the committed TS/Go artifacts
	$(PNPM) --filter @qd/qd-account gen

e2e-shared:  ## Multi-user shared-wallet E2E (needs web build; starts static server, in-memory API and Anvil on :8547)
	cd apps/web && npx playwright test -c playwright.shared.config.ts

typecheck:   ## Typecheck all TS
	$(PNPM) -r typecheck

fund:        ## Send 10 ETH on Anvil to ADDRESS=0x...
	cast send --rpc-url http://127.0.0.1:8545 --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 $(ADDRESS) --value 10ether

relayer-status: ## Show the running API's relayer diagnostics (chain id, relayer address/balance, contracts)
	@curl -sf http://localhost:8080/v1/relayers | python3 -m json.tool || echo "wallet-api is not running on :8080 (make api)"
