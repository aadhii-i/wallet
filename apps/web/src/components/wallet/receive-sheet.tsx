'use client';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import QRCode from 'qrcode';
import { ExternalLink, Share2 } from 'lucide-react';
import type { ApiClient } from '@qd/rpc';
import { btcDerivationPath, evmDerivationPath, hederaDerivationPath } from '@qd/wallet-core';
import { useAccountAddress, useNetwork } from '@/lib/hooks';
import { toast, useMeta, useSelectedAccount } from '@/lib/store';
import { vault } from '@/lib/vault-client';
import { getApi } from '@/lib/api';
import { validateHederaAccountId } from '@/lib/hedera-api';
import {
  createAndRegisterHederaAccount,
  createStaleGuard,
  describeHederaError,
  findRemoteAccount,
  readLinkedHederaAccount,
  registerExistingHederaAccount,
  type HederaCreateDeps,
  type HederaRegistrationDeps,
  type StaleGuard,
} from '@/lib/hedera-link';
import {
  buildAndSubmitHbarTransfer,
  buildAndSubmitHederaAccountCreate,
  getHederaAccountBalance,
  getTransactionReceipt,
  hbarDisplayToTinybars,
  hederaAccountExplorerUrl,
  hederaTransactionExplorerUrl,
  verifyHederaAccountOwnership,
} from '@/lib/hedera-transfer';
import { Button } from '../ui/button';
import { ChunkedAddress, CopyButton, Identicon } from '../ui/identity';
import { Sheet } from '../ui/sheet';
import { Skeleton } from '../ui/spinner';
import { t } from '../ui/motion';

/**
 * Builds the registration dependencies for one operation. `walletApiId` is
 * captured by the caller so every lookup in that operation is scoped to the
 * same wallet.
 */
function registrationDeps(
  api: ApiClient,
  walletApiId: string | undefined,
): HederaRegistrationDeps {
  return {
    getRemoteAccount: async (hdIndex) => {
      const { wallets } = await api.wallets();
      return findRemoteAccount(wallets, walletApiId, hdIndex);
    },
    derivePublicKey: async (hdIndex) => {
      const { publicKey } = await vault.call('hederaPublicKey', { index: hdIndex });
      return publicKey;
    },
    verifyOwnership: (accountId, publicKeyHex) =>
      verifyHederaAccountOwnership(accountId, publicKeyHex),
    register: async (accountApiId, accountId, publicKeyHex) => {
      await api.registerHederaAddress(accountApiId, accountId, publicKeyHex);
    },
  };
}

export function ReceiveSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const account = useSelectedAccount();
  const network = useNetwork();
  const address = useAccountAddress();
  const btcAddressType = useMeta((s) => s.btcAddressType);
  const setBtcAddressType = useMeta((s) => s.setBtcAddressType);
  const setHederaAccountId = useMeta((s) => s.setHederaAccountId);
  const linkedHederaAccountId = useMeta((s) =>
    readLinkedHederaAccount(s.hederaAccountIds, account?.index),
  );
  const [qr, setQr] = useState<string | null>(null);
  const [hederaInput, setHederaInput] = useState('');
  const [hederaRegistering, setHederaRegistering] = useState(false);
  const [walletPubKey, setWalletPubKey] = useState<string | null>(null);
  const [createPayerId, setCreatePayerId] = useState('');
  const [createPayerKey, setCreatePayerKey] = useState('');
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<{
    accountId: string;
    transactionId: string;
    hdIndex: number;
    linked: boolean;
  } | null>(null);
  const [retryingRegistration, setRetryingRegistration] = useState(false);
  const [accountBalance, setAccountBalance] = useState<{ tinybars: bigint; hbar: string } | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [transferResult, setTransferResult] = useState<{
    transactionId: string;
    status: string;
    hashScanUrl: string;
  } | null>(null);

  const isHedera = network.family === 'hedera';
  const accountIndex = account?.index;

  // One guard for all "show the public key" requests: a response for an older
  // account selection must never overwrite the current one.
  const pubKeyGuardRef = useRef<StaleGuard | null>(null);
  if (pubKeyGuardRef.current === null) pubKeyGuardRef.current = createStaleGuard();

  // Derive and show the wallet's Hedera public key when the sheet opens.
  useEffect(() => {
    const guard = pubKeyGuardRef.current!;
    if (!open || !isHedera || accountIndex === undefined) {
      guard.invalidate();
      setWalletPubKey(null);
      return;
    }
    const token = guard.begin();
    setWalletPubKey(null);
    void vault
      .call('hederaPublicKey', { index: accountIndex })
      .then((r) => {
        if (guard.isCurrent(token)) setWalletPubKey(r.publicKey);
      })
      .catch(() => {
        if (guard.isCurrent(token)) setWalletPubKey(null);
      });
    return () => guard.invalidate();
  }, [open, isHedera, accountIndex]);

  useEffect(() => {
    if (!open || !address) return;
    setQr(null);
    QRCode.toDataURL(address, { margin: 1, width: 440, errorCorrectionLevel: 'M', color: { dark: '#070B14', light: '#FFFFFF' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [open, address]);

  async function registerHederaAccount() {
    const accountId = hederaInput.trim();
    if (!account || !validateHederaAccountId(accountId)) return;
    // Resolve the index once; every step of this operation uses it.
    const hdIndex = account.index;
    setHederaRegistering(true);
    try {
      const api = await getApi();
      await api.ensureSession();
      const walletApiId = useMeta.getState().walletApiId;
      await registerExistingHederaAccount(
        { hdIndex, accountId },
        registrationDeps(api, walletApiId),
      );
      setHederaAccountId(hdIndex, accountId);
      toast.success('Hedera account linked', accountId);
      setHederaInput('');
    } catch (e) {
      const info = describeHederaError(e, 'link');
      toast.error(info.title, info.description);
    } finally {
      setHederaRegistering(false);
    }
  }

  async function createHederaAccount() {
    if (!account) return;
    if (!validateHederaAccountId(createPayerId.trim())) return;
    if (!createPayerKey.trim()) return;
    // Resolve the index once; the key is derived fresh for this same index
    // immediately before the transaction is submitted.
    const hdIndex = account.index;
    setCreatingAccount(true);
    try {
      const api = await getApi();
      await api.ensureSession();
      const walletApiId = useMeta.getState().walletApiId;
      const deps: HederaCreateDeps = {
        ...registrationDeps(api, walletApiId),
        createOnChain: (args) => buildAndSubmitHederaAccountCreate(args),
      };
      const created = await createAndRegisterHederaAccount(
        {
          hdIndex,
          payerAccountId: createPayerId.trim(),
          payerPrivateKeyHex: createPayerKey.trim(),
        },
        deps,
      );

      setCreatedAccount({
        accountId: created.newAccountId,
        transactionId: created.transactionId,
        hdIndex: created.hdIndex,
        linked: created.linked,
      });

      if (created.linked) {
        setHederaAccountId(created.hdIndex, created.newAccountId);
        toast.success('Hedera account created and linked', created.newAccountId);
        setCreatePayerId('');
        void fetchAccountBalance(created.newAccountId);
      } else {
        // The account exists and is funded on-chain. Keep its ID for recovery;
        // never submit another CREATE ACCOUNT automatically.
        toast.error(
          'Account created on-chain, but registration failed',
          created.registrationError?.description ??
            `Account ${created.newAccountId} was created. Retry registration below.`,
        );
      }
    } catch (e) {
      const info = describeHederaError(e, 'create');
      toast.error(info.title, info.description);
    } finally {
      // Never let the payer private key persist in state, even on error.
      setCreatePayerKey('');
      setCreatingAccount(false);
    }
  }

  async function retryRegistration() {
    if (!createdAccount || createdAccount.linked) return;
    const { accountId, hdIndex } = createdAccount;
    setRetryingRegistration(true);
    try {
      const api = await getApi();
      await api.ensureSession();
      const walletApiId = useMeta.getState().walletApiId;
      await registerExistingHederaAccount(
        { hdIndex, accountId },
        registrationDeps(api, walletApiId),
      );
      setHederaAccountId(hdIndex, accountId);
      setCreatedAccount((prev) =>
        prev && prev.accountId === accountId ? { ...prev, linked: true } : prev,
      );
      toast.success('Hedera account linked', accountId);
      void fetchAccountBalance(accountId);
    } catch (e) {
      // Still unlinked; keep the created account ID and transaction ID.
      const info = describeHederaError(e, 'register');
      toast.error(info.title, info.description);
    } finally {
      setRetryingRegistration(false);
    }
  }

  async function fetchAccountBalance(accountId: string) {
    setBalanceLoading(true);
    try {
      const bal = await getHederaAccountBalance(accountId);
      setAccountBalance(bal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Balance lookup failed';
      toast.error('Could not load balance', msg);
    } finally {
      setBalanceLoading(false);
    }
  }

  async function transferHbar() {
    const fromAccountId = linkedHederaAccountId;
    if (!account || !fromAccountId) return;
    if (!createdAccount || !createdAccount.linked || createdAccount.hdIndex !== account.index) return;
    if (!validateHederaAccountId(transferTo.trim())) return;
    const amountTinybars = hbarDisplayToTinybars(transferAmount.trim());
    if (amountTinybars <= 0n) return;
    const hdIndex = account.index;
    setTransferring(true);
    try {
      const api = await getApi();
      await api.ensureSession();
      const walletApiId = useMeta.getState().walletApiId;
      const remote = await registrationDeps(api, walletApiId).getRemoteAccount(hdIndex);
      const { transactionId } = await buildAndSubmitHbarTransfer({
        fromAccountId,
        toAccountId: transferTo.trim(),
        amountTinybars,
        hdIndex,
        accountApiId: remote.id,
      });
      // Fetch the receipt to confirm status.
      const receipt = await getTransactionReceipt(transactionId);
      setTransferResult({
        transactionId,
        status: receipt.status,
        hashScanUrl: hederaTransactionExplorerUrl(transactionId),
      });
      toast.success('HBAR transfer submitted', transactionId);
      setTransferTo('');
      setTransferAmount('');
      // Refresh balance after transfer.
      void fetchAccountBalance(fromAccountId);
    } catch (e) {
      const info = describeHederaError(e, 'transfer');
      toast.error(info.title, info.description);
    } finally {
      setTransferring(false);
    }
  }

  if (!account) return null;

  const path =
    network.family === 'bitcoin'
      ? btcDerivationPath(account.index, btcAddressType, network.bitcoin.chain)
      : network.family === 'hedera'
        ? hederaDerivationPath(account.index)
        : evmDerivationPath(account.index);
  const canChooseBtcType = network.family === 'bitcoin' && network.bitcoin.addressTypes.length > 1;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`Receive on ${network.name}`}>
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex items-center gap-2">
          {address && <Identicon address={address} size={24} />}
          <span className="font-semibold">{account.name}</span>
        </div>
        <p className="mb-3 text-xs text-subtle">
          Derivation path <span className="font-mono">{path}</span>
        </p>
        {canChooseBtcType && (
          <div className="mb-3 w-full rounded-xl bg-sunken px-3 py-2.5 text-left">
            <div role="radiogroup" aria-label="Bitcoin address type" className="flex gap-2">
              {(['p2wpkh', 'p2tr'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={btcAddressType === type}
                  onClick={() => setBtcAddressType(type)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[13px] font-semibold transition-colors ${
                    btcAddressType === type ? 'bg-primary text-on-primary' : 'bg-surface text-muted hover:text-ink'
                  }`}
                >
                  {type === 'p2wpkh' ? 'SegWit (BIP-84)' : 'Taproot (BIP-86)'}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] leading-5 text-subtle">
              {btcAddressType === 'p2wpkh'
                ? 'Default. Native SegWit hides your public key until you spend.'
                : 'Opt-in. Key-path spends reveal your public key on-chain, and Taproot signatures are not post-quantum.'}
            </p>
          </div>
        )}
        {/* Hedera: no address until account ID is registered */}
        {isHedera && !address ? (
          <div className="mb-4 w-full space-y-3">
            <div className="rounded-2xl bg-sunken px-4 py-4 text-sm text-muted text-center space-y-1">
              <p className="font-semibold text-ink">No Hedera Account ID linked</p>
              <p>Hedera accounts are created on-chain. Enter your existing Testnet Account ID (<span className="font-mono">0.0.x</span>) to link it to this wallet key.</p>
            </div>
            {walletPubKey && (
              <div className="rounded-2xl bg-sunken px-4 py-3 text-xs space-y-1">
                <p className="font-semibold text-ink">Your wallet&apos;s Hedera public key</p>
                <p className="text-subtle">The Hedera account you link must use this exact key. Create a new account at the portal using this key, or use an existing account whose key matches.</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono text-[11px] break-all text-muted flex-1">{walletPubKey}</span>
                  <CopyButton value={walletPubKey} />
                </div>
              </div>
            )}
            <input
              type="text"
              value={hederaInput}
              onChange={(e) => setHederaInput(e.target.value)}
              placeholder="0.0.12345"
              className="w-full rounded-2xl border border-line bg-surface px-4 py-3 font-mono text-sm outline-none focus:border-primary"
            />
            <Button
              block
              disabled={!validateHederaAccountId(hederaInput.trim()) || hederaRegistering}
              loading={hederaRegistering}
              onClick={registerHederaAccount}
            >
              Link account
            </Button>
            {network.faucetUrl && (
              <p className="text-center text-xs text-muted">
                Need a Testnet account?{' '}
                <a href={network.faucetUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                  Get one free <ExternalLink size={11} />
                </a>
              </p>
            )}
            <div className="rounded-2xl bg-sunken px-4 py-4 text-sm space-y-2">
                <p className="font-semibold text-ink">Create a new Hedera account</p>
                <p className="text-[12px] text-muted">
                  Creates a new Testnet account controlled by this wallet key. A funded
                  payer account (portal key) is needed to cover the creation fee.
                </p>
                <div className="space-y-2">
                  <input
                    type="text"
                    value={createPayerId}
                    onChange={(e) => setCreatePayerId(e.target.value)}
                    placeholder="Payer account ID (0.0.x)"
                    className="w-full rounded-xl border border-line bg-surface px-4 py-3 font-mono text-sm outline-none focus:border-primary"
                  />
                  <input
                    type="text"
                    value={createPayerKey}
                    onChange={(e) => setCreatePayerKey(e.target.value)}
                    placeholder="Payer private key (portal key)"
                    className="w-full rounded-xl border border-line bg-surface px-4 py-3 font-mono text-sm outline-none focus:border-primary"
                  />
                  <Button
                    block
                    disabled={
                      !validateHederaAccountId(createPayerId.trim()) ||
                      !createPayerKey.trim() ||
                      creatingAccount
                    }
                    loading={creatingAccount}
                    onClick={createHederaAccount}
                  >
                    Create account
                  </Button>
                </div>
                {createdAccount && createdAccount.hdIndex === account.index && (
                  <div className="space-y-2">
                    <p className={`text-[12px] ${createdAccount.linked ? 'text-success' : 'text-ink'}`}>
                      New account{' '}
                      <a
                        href={hederaAccountExplorerUrl(createdAccount.accountId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono underline hover:no-underline"
                      >
                        {createdAccount.accountId}
                      </a>{' '}
                      {createdAccount.linked
                        ? 'created and linked.'
                        : 'was created on-chain, but backend registration failed.'}
                    </p>
                    <p className="text-[11px] text-muted">
                      Transaction ID: <span className="font-mono">{createdAccount.transactionId}</span>
                    </p>
                    {!createdAccount.linked && (
                      <div className="rounded-xl border border-line bg-surface px-3 py-2 space-y-2">
                        <p className="text-[11px] text-muted">
                          The account exists and is funded. Retry registration with the same account
                          ID — no new account will be created.
                        </p>
                        <Button block loading={retryingRegistration} onClick={retryRegistration}>
                          Retry registration
                        </Button>
                      </div>
                    )}
                    {createdAccount.linked && (
                      <>
                        {/* Balance */}
                        <div className="flex items-center justify-between px-3 py-2 rounded-xl border border-line bg-surface">
                          <span className="text-[12px] text-muted">HBAR balance</span>
                          <span className="text-[12px] font-mono">
                            {balanceLoading ? '…' : accountBalance ? `${accountBalance.hbar} HBAR` : '—'}
                          </span>
                        </div>
                        {/* Transfer form */}
                        <div className="space-y-2">
                          <p className="text-[12px] font-semibold text-ink">Send HBAR from this account</p>
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={transferTo}
                              onChange={(e) => setTransferTo(e.target.value)}
                              placeholder="Recipient account ID (0.0.x)"
                              className="w-full rounded-xl border border-line bg-surface px-4 py-3 font-mono text-sm outline-none focus:border-primary"
                            />
                            <input
                              type="text"
                              value={transferAmount}
                              onChange={(e) => setTransferAmount(e.target.value)}
                              placeholder="Amount (HBAR, e.g. 0.01)"
                              className="w-full rounded-xl border border-line bg-surface px-4 py-3 font-mono text-sm outline-none focus:border-primary"
                            />
                            <Button
                              block
                              disabled={
                                !validateHederaAccountId(transferTo.trim()) ||
                                !transferAmount.trim() ||
                                transferring
                              }
                              loading={transferring}
                              onClick={transferHbar}
                            >
                              Send HBAR
                            </Button>
                          </div>
                        </div>
                        {/* Transfer receipt */}
                        {transferResult && (
                          <div className="rounded-xl border border-success-soft bg-success-soft px-3 py-2 space-y-1">
                            <p className="text-[12px] font-semibold text-success">Transfer submitted</p>
                            <p className="text-[11px] text-muted">Transaction ID: <span className="font-mono">{transferResult.transactionId}</span></p>
                            <p className="text-[11px] text-muted">Status: <span className="font-semibold">{transferResult.status}</span></p>
                            <a
                              href={transferResult.hashScanUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-success hover:underline inline-flex items-center gap-1"
                            >
                              View on HashScan <ExternalLink size={11} />
                            </a>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
          </div>
        ) : (
          <>
            <div className="relative mb-4 h-56 w-56 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-line">
              {address && qr ? (
                <motion.img initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={t.base} src={qr} alt={`QR code for ${address}`} className="h-full w-full" />
              ) : (
                <Skeleton className="h-full w-full" />
              )}
            </div>
            <div className="mb-3 flex w-full items-center gap-1 rounded-2xl bg-sunken px-4 py-3 text-left">
              {address ? (
                <>
                  <ChunkedAddress address={address} className="min-w-0 flex-1" />
                  <CopyButton value={address} />
                </>
              ) : (
                <Skeleton className="h-6 w-full" />
              )}
            </div>
          </>
        )}
        <p className="mb-4 rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-ink">
          Only send <strong>{network.name}</strong> assets to this address. Assets sent from other networks may be lost.
        </p>
        {network.faucetUrl && (
          <div className="mb-4 w-full rounded-xl bg-primary-soft px-3 py-2 text-left text-[13px] text-ink">
            <p className="mb-1 font-semibold">Need free test {network.nativeCurrency.symbol}?</p>
            <p>
              Copy the address above, paste it into the{' '}
              <a href={network.faucetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                {network.shortName} faucet <ExternalLink size={12} />
              </a>{' '}
              and request funds. Test funds have no real value. Your balance updates automatically once they arrive.
            </p>
          </div>
        )}
        {address && typeof navigator !== 'undefined' && 'share' in navigator && (
          <Button
            variant="secondary"
            block
            onClick={() => navigator.share({ text: address }).catch(() => toast.info('Sharing cancelled'))}
          >
            <Share2 size={18} /> Share address
          </Button>
        )}
      </div>
    </Sheet>
  );
}
