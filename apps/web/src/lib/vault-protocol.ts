import type * as H from '@qd/hedera';
import type { HederaSharedContext, PolicyBackup } from '@qd/wallet-core';
import type { ConfirmationToken, SignatureResult, SigningPayload, SigningRequest } from '@qd/wallet-core';
import type { BitcoinAddressType } from '@qd/blockchain';
import type { BitcoinSharedContext } from '@qd/wallet-core';
import type {
  BitcoinEnrollment,
  BitcoinSharedPolicy,
  SharedBitcoinProposal,
  BitcoinApproval,
  BitcoinRound,
  BitcoinConsent,
} from '@qd/bitcoin';

export type BitcoinNetworkName = 'mainnet' | 'testnet4';

/** Typed message protocol between the UI thread and the KeyWorker. */
export interface VaultOps {
  hSharedEnroll: {
    req: { context: HederaSharedContext; participantId: string; derivationIndex: number };
    res: H.HederaEnrollment;
  };
  hSharedPin: { req: { policy: H.HederaSharedPolicy; confirmation: ConfirmationToken }; res: { policyId: string } };
  hSharedBind: {
    req: { policy: H.HederaSharedPolicy; account: H.HederaAccountInfo; confirmation: ConfirmationToken };
    res: { accountId: string };
  };
  hSharedStatus: { req: { policy: H.HederaSharedPolicy }; res: import('./hedera-worker').HederaState };
  hSharedApprove: {
    req: {
      policy: H.HederaSharedPolicy;
      proposal: H.HederaProposal;
      account: H.HederaAccountInfo;
      confirmation: ConfirmationToken;
    };
    res: H.HederaConsent;
  };
  hSharedRound: {
    req: {
      policy: H.HederaSharedPolicy;
      proposal: H.HederaProposal;
      consents: H.HederaConsent[];
      round: 1 | 2 | 3;
      inputs: H.HederaRound[];
    };
    res: H.HederaRound;
  };
  hSharedNative: {
    req: {
      policy: H.HederaSharedPolicy;
      proposal: H.HederaProposal;
      approval: H.HederaApproval;
      account: H.HederaAccountInfo;
    };
    res: H.HederaPartial;
  };
  hSharedFinalize: {
    req: {
      policy: H.HederaSharedPolicy;
      proposal: H.HederaProposal;
      approval: H.HederaApproval;
      partials: H.HederaPartial[];
    };
    res: { raw: string; transactionId: string; expiresAt: number; intentMemo: string };
  };
  hSharedFinalizeRotation: {
    req: {
      policy: H.HederaSharedPolicy;
      source: H.HederaProposal;
      sourceApproval: H.HederaApproval;
      sourcePartials: H.HederaPartial[];
      target: H.HederaProposal;
      targetApproval: H.HederaApproval;
      targetPartials: H.HederaPartial[];
    };
    res: { raw: string; transactionId: string; expiresAt: number; intentMemo: string };
  };
  hSharedCreate: {
    req: {
      policy: H.HederaSharedPolicy;
      plan: H.HederaPlan;
      payerIndex: number;
      payer: H.HederaAccountInfo;
      confirmation: ConfirmationToken;
    };
    res: { raw: string; transactionId: string; expiresAt: number; intentMemo: string };
  };
  hSharedReconcile: {
    req: {
      policy: H.HederaSharedPolicy;
      id: string;
      account: H.HederaAccountInfo;
      receipt: {
        found: boolean;
        transactionId: string;
        result?: string;
        timestamp?: string;
        intentMemo?: string;
        entityId?: string;
      };
    };
    res: import('./hedera-worker').HederaState;
  };
  hSharedExport: { req: { policy: H.HederaSharedPolicy }; res: PolicyBackup };
  hSharedImport: {
    req: { backup: PolicyBackup; password: string };
    res: { policy: H.HederaSharedPolicy; accountId?: string };
  };

  btcSharedEnroll: {
    req: { context: BitcoinSharedContext; participantId: string; derivationIndex: number };
    res: BitcoinEnrollment;
  };
  btcSharedPin: { req: { policy: BitcoinSharedPolicy; confirmation: ConfirmationToken }; res: { policyId: string } };
  btcSharedPlan: {
    req: { policy: BitcoinSharedPolicy; highestUsed?: number };
    res: { next: number; unavailable: string[] };
  };
  btcSharedApprove: {
    req: { policy: BitcoinSharedPolicy; proposal: SharedBitcoinProposal; confirmation: ConfirmationToken };
    res: { message: string; from: number; nonce: string };
  };
  btcSharedRound: {
    req: {
      policy: BitcoinSharedPolicy;
      proposal: SharedBitcoinProposal;
      consents: BitcoinConsent[];
      round: 1 | 2 | 3;
      inputs: BitcoinRound[];
    };
    res: BitcoinRound;
  };
  btcSharedNativeSign: {
    req: { policy: BitcoinSharedPolicy; proposal: SharedBitcoinProposal; approval: BitcoinApproval };
    res: { partial: string; from: number };
  };
  btcSharedFinalize: {
    req: {
      policy: BitcoinSharedPolicy;
      proposal: SharedBitcoinProposal;
      approval: BitcoinApproval;
      partials: string[];
    };
    res: { txid: string; raw: string; vsize: number };
  };
  btcSharedStatus: { req: { policy: BitcoinSharedPolicy }; res: import('./bitcoin-worker').BitcoinSharedState };
  btcSharedExport: { req: { policy: BitcoinSharedPolicy }; res: PolicyBackup };
  btcSharedImport: { req: { backup: PolicyBackup; password: string }; res: { policy: BitcoinSharedPolicy } };
  btcSharedSaved: {
    req: { policy: BitcoinSharedPolicy; id: string };
    res: { proposal: SharedBitcoinProposal; final?: { txid: string; raw: string; vsize: number } };
  };
  btcSharedReconcile: {
    req: { policy: BitcoinSharedPolicy; id: string; txid: string; status: 'pending' | 'confirmed' };
    res: void;
  };
  status: { req: void; res: VaultStatus };
  create: { req: { password: string; words: 12 | 24 }; res: { address: string } };
  import: { req: { mnemonic: string; password: string }; res: { address: string } };
  unlock: { req: { password: string }; res: { ok: true } };
  lock: { req: void; res: void };
  addresses: { req: { indexes: number[] }; res: string[] };
  /** BIP-84/86 address plus its derivation path, derived inside the worker. */
  btcAddress: {
    req: { index: number; network: BitcoinNetworkName; addressType: BitcoinAddressType };
    res: { address: string; path: string };
  };
  /** Account-level public descriptor for Bitcoin address derivation. */
  btcDescriptor: {
    req: { network: BitcoinNetworkName; addressType: BitcoinAddressType };
    res: { descriptor: string; xpub: string; fingerprint: string };
  };
  btcChangeAddresses: {
    req: {
      account: number;
      start: number;
      count: number;
      network: BitcoinNetworkName;
      addressType: BitcoinAddressType;
    };
    res: { address: string; changeIndex: number }[];
  };
  btcChangeDescriptor: {
    req: { account: number; network: BitcoinNetworkName; addressType: BitcoinAddressType };
    res: { descriptor: string; xpub: string; fingerprint: string };
  };
  btcChangePlan: {
    req: { account: number; network: BitcoinNetworkName; addressType: BitcoinAddressType; highestUsed?: number };
    res: {
      address: string;
      index: number;
      unavailable: string[];
      pending: { txid: string; raw: string; createdAt: number }[];
    };
  };
  getBackupPhrase: { req: void; res: string };
  markBackedUp: { req: void; res: void };
  revealPhrase: { req: { password: string }; res: string };
  verifyPassword: { req: { password: string }; res: boolean };
  changePassword: { req: { oldPassword: string; newPassword: string }; res: void };
  issueConfirmation: { req: { payload: SigningPayload }; res: ConfirmationToken };
  sign: { req: SigningRequest; res: SignatureResult };
  signAddressProof: { req: { index: number; message: string }; res: string };
  /** Bitcoin ownership proof: `0x` + pubkey(33) + compact ECDSA sig(64). */
  signBtcAddressProof: {
    req: { index: number; network: BitcoinNetworkName; addressType: BitcoinAddressType; message: string };
    res: { proof: string };
  };
  /** Compressed secp256k1 public key (33-byte, lowercase hex) for a Hedera account. */
  hederaPublicKey: { req: { index: number }; res: { publicKey: string } };
  setAutoLock: { req: { minutes: number }; res: void };
  // Shared-wallet QD key material. Results carry only public values.
  qdShareUnlock: { req: { password: string }; res: void };
  qdShareStatus: { req: { walletId: string }; res: QdShareStatus };
  qdPrepareKeygen: { req: { walletId: string; keygenId: string; participantId: string }; res: { publicKey: string } };
  qdDeal: { req: QdDealRequest; res: QdDealResult };
  qdAcceptShare: { req: QdAcceptRequest; res: { fingerprint: string; partyIndex: number } };
  // Networked Threshold Raccoon signing. Results are public protocol values.
  qdAccountKey: { req: { walletId: string; derivationIndex: number }; res: QdAccountKey };
  qdSignRound: { req: QdSignRoundRequest; res: { payload: string } };
  qdForgetSession: { req: { sessionId: string }; res: void };
  qdVerifySignature: {
    req: { walletId: string; derivationIndex: number; message: string; signature: string };
    res: boolean;
  };
  wipe: { req: void; res: void };
}

export type VaultOp = keyof VaultOps;

export interface VaultStatus {
  hasVault: boolean;
  unlocked: boolean;
  backedUp: boolean;
  /** Unix ms until which unlock attempts are refused (brute-force delay). */
  lockedUntil: number;
}

export interface VaultRequestMsg<K extends VaultOp = VaultOp> {
  id: number;
  op: K;
  args: VaultOps[K]['req'];
}

export type VaultResponseMsg =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }
  | { event: 'locked' };

/** Public metadata about the share this device holds for a wallet (never the share). */
export interface QdShareStatus {
  storeExists: boolean;
  storeUnlocked: boolean;
  share: {
    keygenId: string;
    participantId: string;
    partyIndex: number;
    threshold: number;
    parties: number;
    membershipVersion: number;
    fingerprint: string;
    storedAt: string;
  } | null;
}

export interface QdDealRequest {
  walletId: string;
  keygenId: string;
  threshold: number;
  parties: number;
  membershipVersion: number;
  /** publicKey: base64url X-Wing public key registered by each participant's device. */
  recipients: { participantId: string; partyIndex: number; publicKey: string }[];
}

/** Envelopes are HPKE ciphertexts (base64url); only their recipient can open them. */
export interface QdDealResult {
  fingerprint: string;
  envelopes: { participantId: string; partyIndex: number; enc: string; ct: string }[];
}

export interface QdAcceptRequest {
  walletId: string;
  keygenId: string;
  participantId: string;
  partyIndex: number;
  threshold: number;
  parties: number;
  membershipVersion: number;
  fingerprint: string;
  enc: string;
  ct: string;
}

/** pk_j for a shared account, derived inside the worker from this device's share. */
export interface QdAccountKey {
  /** base64url, 5152 bytes: seedA ‖ t. Public. */
  publicKey: string;
  /** 0x keccak256("QD-VK-v1" ‖ pk) */
  publicKeyHash: string;
  keygenId: string;
  partyIndex: number;
}

/**
 * One signing round for this device's party. `inputs` are the previous
 * round's payloads (base64url) in active-set order: none for round 1.
 */
export interface QdSignRoundRequest {
  walletId: string;
  keygenId: string;
  sessionId: string;
  sid: string; // 64 hex
  act: number[];
  derivationIndex: number;
  message: string; // 0x + 64 hex
  publicKeyHash: string; // 0x + 64 hex; must equal this device's own pk_j hash
  round: 1 | 2 | 3;
  inputs: string[];
}
