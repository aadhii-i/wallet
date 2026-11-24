import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { bech32, bech32m } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { HDKeyring, bytesToHex, decodeBitcoinAddress, fromHex } from '@qd/wallet-core';
import { BITCOIN_NETWORKS, type BitcoinNetwork } from '@qd/blockchain';
import { BitcoinSigner, buildPsbt, extractSignedTx, scriptPubKeyHex, selectCoins, type BtcUtxo } from '../src';

/** Never uses a supplied RPC URL: every run starts its own offline regtest node. */
describe.skipIf(!process.env.BITCOIND_BIN)('Bitcoin Core consensus and change spending', () => {
  for (const type of ['p2wpkh', 'p2tr'] as const)
    it(`mines and spends fresh ${type} change after key restoration`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'qd-bitcoin-regtest-'));
      const port = 25000 + Math.floor(Math.random() * 15000);
      const proc = spawn(
        process.env.BITCOIND_BIN!,
        [
          '-regtest',
          '-server=1',
          '-listen=0',
          '-dnsseed=0',
          '-discover=0',
          '-connect=0',
          '-printtoconsole=0',
          `-datadir=${directory}`,
          `-rpcport=${port}`,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      let startupError: Error | undefined;
      proc.on('error', (error) => {
        startupError = error;
      });
      const rpc = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
        const cookie = (await readFile(join(directory, 'regtest', '.cookie'), 'utf8')).trim();
        const response = await fetch(`http://127.0.0.1:${port}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(cookie).toString('base64')}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const data = (await response.json()) as { result: T; error?: { message: string } };
        if (data.error) throw new Error(data.error.message);
        return data.result;
      };
      let keys: HDKeyring | undefined;
      try {
        for (let attempt = 0; ; attempt++) {
          if (startupError) throw startupError;
          try {
            expect((await rpc<{ chain: string }>('getblockchaininfo')).chain).toBe('regtest');
            break;
          } catch (error) {
            if (attempt >= 100) throw error;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
        keys = await HDKeyring.fromMnemonic(phrase);
        const from = keys.btcAddress(0, type, 'testnet4'),
          to = keys.btcAddress(8, type, 'testnet4');
        const regtestAddress = (address: string) => {
          const decoded = decodeBitcoinAddress(address),
            codec = decoded.version === 0 ? bech32 : bech32m;
          return codec.encode('bcrt', [decoded.version, ...codec.toWords(decoded.program)]);
        };
        const blocks = await rpc<string[]>('generatetoaddress', [101, regtestAddress(from)]);
        const block = await rpc<{ tx: { txid: string }[] }>('getblock', [blocks[0], 2]);
        const previousTx = await rpc<string>('getrawtransaction', [block.tx[0]!.txid, false, blocks[0]]);
        const previous = Transaction.fromRaw(fromHex(previousTx), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        });
        let input: BtcUtxo = {
          txid: previous.id,
          vout: 0,
          value: previous.getOutput(0).amount!,
          scriptPubKey: scriptPubKeyHex(from),
          confirmations: 101,
          previousTx,
          address: from,
          coinbase: true,
        };
        for (let changeIndex = 0; changeIndex < 2; changeIndex++) {
          if (changeIndex === 1) {
            keys.lock();
            keys = await HDKeyring.fromMnemonic(phrase);
            expect(keys.btcChangeAddress(0, 0, type, 'testnet4')).toBe(input.address);
          }
          const amount = 100_000_000n;
          const unsigned = buildPsbt({
            network: BITCOIN_NETWORKS.find((n) => n.id === 'btc-testnet4')! as BitcoinNetwork,
            addressType: type,
            from,
            to,
            changeAddress: keys.btcChangeAddress(0, changeIndex, type, 'testnet4'),
            changeIndex,
            amount,
            selection: selectCoins([input], amount, 2, type),
          });
          const signer = new BitcoinSigner(keys);
          const payload = {
            kind: 'btc-psbt' as const,
            network: 'testnet4' as const,
            addressType: type,
            from,
            psbt: unsigned.psbt,
            review: unsigned.review,
          };
          const result = signer.sign({
            account: { id: 'regtest', hdIndex: 0 },
            payload,
            confirmation: signer.confirmations.issue(payload),
          });
          if (result.kind !== 'btc-psbt') throw new Error('unexpected signature');
          const signed = extractSignedTx(result.psbt);
          const acceptance = await rpc<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [
            [signed.rawHex],
          ]);
          expect(acceptance[0], JSON.stringify(acceptance)).toMatchObject({ allowed: true });
          expect(await rpc('sendrawtransaction', [signed.rawHex])).toBe(signed.txid);
          await rpc('generatetoaddress', [1, regtestAddress(to)]);
          const output = await rpc<{ confirmations: number }>('gettxout', [signed.txid, 1]);
          expect(output.confirmations).toBe(1);
          input = {
            txid: signed.txid,
            vout: 1,
            value: unsigned.change,
            scriptPubKey: scriptPubKeyHex(unsigned.changeAddress),
            confirmations: 1,
            previousTx: signed.rawHex,
            address: unsigned.changeAddress,
            changeIndex,
          };
          expect(bytesToHex(Transaction.fromRaw(fromHex(signed.rawHex)).getOutput(1).script!)).toBe(input.scriptPubKey);
        }
      } finally {
        keys?.lock();
        try {
          await rpc('stop');
        } catch {}
        if (proc.exitCode === null)
          await Promise.race([new Promise((r) => proc.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
        if (proc.exitCode === null) proc.kill();
        const resolved = await realpath(directory),
          temporary = await realpath(tmpdir());
        if (!resolved.startsWith(resolve(temporary) + sep) || !basename(resolved).startsWith('qd-bitcoin-regtest-'))
          throw new Error('Unsafe temporary cleanup path');
        await rm(resolved, { recursive: true, force: true });
      }
    }, 120000);
});
