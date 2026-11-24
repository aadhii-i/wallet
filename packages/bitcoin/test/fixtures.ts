// Browser E2E fixtures share Bitcoin's declared dependency instead of relying
// on hoisted transitive dependencies in the web package.
export { Transaction, TEST_NETWORK } from '@scure/btc-signer';
