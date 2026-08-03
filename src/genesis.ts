import { generateGenesis } from './graph/genesis.ts';
import { Hash } from './util/Hash.ts';
import { bin2hex } from './util/hex.ts';
import { secp } from './util/secp.ts';

export function makeDefaultGenesis() {
  const privateKeys = ['alice', 'bob', 'charlie'].map((name) =>
    Hash.digest(`scaffold:testnet:${name}`).toBytes()
  );

  const funding = Object.fromEntries(
    privateKeys.map((key) => [bin2hex(secp.getPublicKey(key, true)), 1_000_000n]),
  );

  const genesis = generateGenesis('default', funding);

  for (const [publicKey, amount] of Object.entries(funding)) {
    console.warn(`Genesis output: ${publicKey} has ${amount}`);
  }
  console.warn(`Genesis block hash: ${Hash.digest(genesis).toHex()}`);

  return { genesis, privateKeys };
}
