# QD Wallet developer commands. Requires: pnpm (via corepack), Go 1.26+, Docker.
PNPM := corepack pnpm@9.15.0
API  := services/wallet-api

# Server-side secrets (e.g. EVM_RPC_11155111) for `make api`. Gitignored.
-include .env

.PHONY: help install up down anvil api web build test test-ts test-go e2e lint typecheck fund

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

api:         ## Run wallet-api on the host with in-memory store against host Anvil
	cd $(API) && CGO_ENABLED=0 APP_ENV=development STORE=memory COOKIE_SECURE=false ALLOWED_ORIGINS=http://localhost:3000 EVM_RPC_31337=anvil=http://127.0.0.1:8545 EVM_RPC_11155111='$(EVM_RPC_11155111)' PRICE_PROVIDER=static go run ./cmd/wallet-api

web:         ## Run the web app in dev mode
	$(PNPM) --filter @qd/web dev

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

typecheck:   ## Typecheck all TS
	$(PNPM) -r typecheck

fund:        ## Send 10 ETH on Anvil to ADDRESS=0x...
	cast send --rpc-url http://127.0.0.1:8545 --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 $(ADDRESS) --value 10ether
