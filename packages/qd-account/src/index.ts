/**
 * QD smart accounts: the on-chain side of a shared wallet's Threshold Raccoon
 * key. A QD account key pk_j cannot sign an Ethereum transaction (it is not
 * secp256k1), so funds live in a QdAccount contract whose only authority is
 * a Raccoon signature verified on chain by QdRaccoonVerifier (ADR 0019).
 *
 * Everything here is public data: addresses, the execution message and
 * calldata. No secret material passes through this package.
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { QdAccount, QdAccountFactory, QdRaccoonVerifier } from './artifacts';

export { QdAccount, QdAccountFactory, QdRaccoonVerifier };

/**
 * The deterministic-deployment proxy (Arachnid), pre-installed by Anvil and
 * present on most public chains. Deploying through it with a fixed salt
 * gives the verifier and factory the same address on every chain.
 */
export const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const DEPLOY_SALT: Hex = keccak256(toBytes('QDWallet.contracts.v1'));

export const PUBLIC_KEY_BYTES = 5152;
export const SIGNATURE_BYTES = 19494;
export const MATRIX_ENTRIES = 20;
/** Per-transaction gas cap on public chains since Fusaka (EIP-7825). */
export const EIP7825_TX_GAS_CAP = 16_777_216n;
/**
 * Matrix entries expanded per transaction. The computation (~3.7M gas per
 * entry) stays under the EIP-7825 cap; under Amsterdam (EIP-8037, live on
 * Sepolia) storing each entry adds ~12.8M of state-creation gas, which is
 * charged outside that cap (~33M total per transaction).
 */
export const MATRIX_ENTRIES_PER_TX = 2;

export const EXECUTE_TYPEHASH: Hex = keccak256(
  toBytes(
    'QDWallet.Execute(uint256 chainId,address account,uint256 nonce,address to,uint256 value,bytes32 dataHash,uint256 callGasLimit,uint256 validUntil,bytes32 proposalDigest)',
  ),
);

export function create2Address(initCode: Hex): Address {
  return getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: toBytes(DEPLOY_SALT), bytecode: initCode });
}

export function verifierInitCode(): Hex {
  return QdRaccoonVerifier.bytecode as Hex;
}

export function factoryInitCode(): Hex {
  return concatHex([QdAccountFactory.bytecode as Hex, encodeAbiParameters([{ type: 'address' }], [verifierAddress()])]);
}

export function verifierAddress(): Address {
  return create2Address(verifierInitCode());
}

export function factoryAddress(): Address {
  return create2Address(factoryInitCode());
}

/** keccak256("QD-VK-v1" ‖ pk): identical to qd-crypto `publicKeyHash` for the encoded key. */
export function publicKeyHashHex(publicKey: Uint8Array): Hex {
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new Error('qd-account: bad public key length');
  return keccak256(concatHex([toHex(toBytes('QD-VK-v1')), toHex(publicKey)]));
}

/** The QdAccount address for pk_j: CREATE2(factory, salt = H(vk), QdAccount(verifier, H(vk))). */
export function accountAddress(publicKeyHash: Hex): Address {
  const initCode = concatHex([
    QdAccount.bytecode as Hex,
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [verifierAddress(), publicKeyHash]),
  ]);
  return getContractAddress({ opcode: 'CREATE2', from: factoryAddress(), salt: toBytes(publicKeyHash), bytecode: initCode });
}

/** One authorised call (QdAccount.Call). */
export interface AccountCall {
  nonce: bigint;
  to: Address;
  value: bigint;
  data: Hex;
  callGasLimit: bigint;
  validUntil: bigint;
  proposalDigest: Hex;
}

/** The 32-byte message the Threshold Raccoon signers sign (QdAccount.executionMessage). */
export function executionMessage(chainId: bigint, account: Address, c: AccountCall): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' },
        { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' },
      ],
      [
        EXECUTE_TYPEHASH, chainId, account, c.nonce, c.to, c.value, keccak256(c.data), c.callGasLimit, c.validUntil,
        c.proposalDigest,
      ],
    ),
  );
}

/**
 * The account call for an approved shared-wallet proposal. The proposal's
 * nonce is the account nonce, its gasLimit is the inner call's gas, its
 * expiry is the on-chain deadline and its SHA-256 digest is bound in.
 */
export function proposalCall(p: {
  nonce: number;
  to: string;
  valueWei: string;
  data: string;
  gasLimit: number;
  expiresAt: string;
  digest: string;
}): AccountCall {
  const validUntil = BigInt(Math.floor(Date.parse(p.expiresAt) / 1000));
  if (!/^[0-9a-f]{64}$/.test(p.digest)) throw new Error('qd-account: bad proposal digest');
  return {
    nonce: BigInt(p.nonce),
    to: p.to as Address,
    value: BigInt(p.valueWei),
    data: (p.data || '0x') as Hex,
    callGasLimit: BigInt(p.gasLimit),
    validUntil,
    proposalDigest: `0x${p.digest}`,
  };
}

export function executeCalldata(c: AccountCall, publicKey: Uint8Array, signature: Uint8Array): Hex {
  return encodeFunctionData({
    abi: QdAccount.abi,
    functionName: 'execute',
    args: [c, toHex(publicKey), toHex(signature)],
  });
}

export function expandMatrixCalldata(seedA: Hex, first: number, count: number): Hex {
  return encodeFunctionData({ abi: QdRaccoonVerifier.abi, functionName: 'expandMatrix', args: [seedA, BigInt(first), BigInt(count)] });
}

export function createAccountCalldata(publicKeyHash: Hex): Hex {
  return encodeFunctionData({ abi: QdAccountFactory.abi, functionName: 'createAccount', args: [publicKeyHash] });
}

/** Calldata for the CREATE2 deployer: salt ‖ initCode. */
export function deployerCalldata(initCode: Hex): Hex {
  return concatHex([DEPLOY_SALT, initCode]);
}
