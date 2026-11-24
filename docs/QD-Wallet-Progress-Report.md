# QD-Wallet — Project Development Progress Report

## 1. Project Overview

QD-Wallet is our university research project on an efficient, quantum-safe, stateless threshold deterministic wallet. We are building a multi-blockchain wallet alongside a cryptographic prototype that lets a minimum number of participants jointly authorize an action using separate key shares. Deterministic derivation lets participants reproduce the keys for a given account from the same inputs. In the research protocol, this derivation requires no shared counter or other evolving state.

## 2. Progress Since the Previous Review

We have extended the initial Ethereum Sepolia wallet to support two additional transaction models. Bitcoin spends individual outputs from earlier transactions, while Hedera uses accounts with network-assigned identifiers. The web wallet now supports network selection, account management, balance display, receiving and sending across these chain families, with chain-specific steps where needed. We also expanded EVM connectivity to Base Sepolia, Arbitrum Sepolia and Polygon Amoy.

## 3. Blockchain Integrations

### Ethereum Sepolia

The Sepolia integration reads ETH balances and transaction history, displays receive addresses, estimates fees, and prepares, signs and tracks transfers. The browser signs with the standard Ethereum signature scheme and submits the signed transaction through the backend. The backend checks the upstream network identity and keeps provider credentials server-side. After two Sepolia transfers ran out of gas, we changed the wallet to estimate gas with the node and add a margin. A live simulation verified the revised behavior. A successful Sepolia send after the fix remains unconfirmed in the project records.

### Bitcoin

We implemented native BTC receiving and sending for Bitcoin mainnet and Testnet4, subject to the backend’s network configuration. Native SegWit is the default address format, and users can select Taproot in the receive interface. Both formats have deterministic address derivation and local signing. The wallet queries available outputs, selects enough to cover the payment and fee, and builds a partially signed transaction for review and signing. It then submits the signed transaction through the backend, which uses a Bitcoin indexing service for network reads and broadcast. Automated tests exercise both signing paths through to a fully formed transaction.

### Hedera

The Hedera Testnet wallet derives a dedicated signing key and can create a network account using a funded payer to cover creation and initial funding. It reads the assigned account ID from the receipt. Users can also link an existing account whose on-chain key matches the selected wallet account. The backend checks the account’s public key through a Hedera Mirror Node and registers the account for use in the wallet. If registration fails after creation, the wallet retains the new account ID so the user can retry linking. The wallet reads HBAR balances through the Mirror Node, signs transfers locally and checks their network receipts.

### Monero

Monero remains at the design stage. We have outlined a client-side wallet that would keep view and spend keys on the device, with restricted backend access to a Monero node. The design also considers a compatible recovery method. Account derivation, synchronization, balances and transfers are still pending.

## 4. Wallet Architecture and Security Improvements

One recovery phrase can reproduce the same EVM, Bitcoin and Hedera keys at a given account index. Each family uses its own derivation rules, and Bitcoin also separates the two address formats and the mainnet and testnet keys. The web wallet encrypts the recovery phrase locally with password-based key protection and keeps unlocked wallet keys in a dedicated browser worker. The signing workflow binds a single-use confirmation to the transaction data approved by the user.

Shared wallet components handle account selection and transaction review, while chain-specific components handle fees, addresses and network communication. EVM and Bitcoin address registration use signed proofs of key control. For Hedera, registration compares the supplied public key with the key recorded for the account on the network. These checks help prevent incorrect account associations. The blockchain-facing signers currently use the conventional signatures accepted by each network.

## 5. Research Implementation Progress

We implemented a standalone Threshold Raccoon prototype for lattice-based signing. A trusted dealer generates the initial secret and distributes shares. Each participant can derive an account-specific share, and the corresponding public key can be derived deterministically. The prototype separates the stable account identifier from a fresh identifier for each signing attempt. This preserves a consistent account key while preventing reuse of the signing masks.

Signing uses three rounds in which participants commit to temporary values, reveal and check them, and produce partial responses that combine into one verifiable signature. The tests simulate the parties in one process, including a two-of-three setup. The prototype has phase-by-phase benchmarks. Device-to-server signing and blockchain transaction authorization are still pending.

## 6. Testing and Demonstrated Results

**Automated tests.** In this review, 318 tests passed across the wallet core, EVM, Bitcoin, web wallet and cryptography suites. Four integration cases were skipped. The backend test suites for accounts, Bitcoin and Hedera also passed. Coverage includes deterministic key derivation, both Bitcoin signing paths, registration and receipt handling, and rejection of altered messages and signatures. Existing project records also document end-to-end Ethereum transfers on a local development chain.

**Public testnet evidence.** Project records document live block reads on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and Polygon Amoy, plus Sepolia activity retrieval and the live transfer simulation. The two recorded Sepolia sends were mined with failed status. Hedera has opt-in live tests for account creation, HBAR transfer and backend registration. Those tests were skipped in this review. A confirmed Hedera or Bitcoin testnet transfer could not be established from the repository evidence reviewed.

## 7. Current Limitations and Future Work

Our next milestone is to run threshold signing between separate participants and test how the protocol handles interrupted sessions, retries and participant failure. We will evaluate the trusted-dealer setup and investigate distributed key generation. We also need to assess how Threshold Raccoon can authorize wallet actions, including the cost of verifying a signature in a smart account, and measure end-to-end latency, message sizes and computation as the number of signers grows.

On the wallet side, we plan to record confirmed public-testnet transfers, exercise Hedera registration and receipt handling against live services, and evaluate Monero’s client-side synchronization and recovery options.

## 8. Conclusion

We have moved from a Sepolia-focused wallet to a shared implementation with Bitcoin and Hedera workflows and a tested Threshold Raccoon prototype. Our next major research milestone is to demonstrate signing across separate participants and measure its cost before integrating it with transaction authorization.
