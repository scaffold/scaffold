import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  composeBlockPacket,
  composeGenesisPacket,
  createGenesisBlock,
  HASH_CONTRACT,
} from '../src/core/Block.ts';
import { hashContract } from '../src/contracts/HashContract.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { secp } from '../src/util/secp.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { SimNode } from './SimNetwork.ts';

Deno.test('HashContract: Scaffold auto-registers hashContract', () => {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  const genesis = composeGenesisPacket([makeSignatureOutput(publicKey, 100)]);
  const scaffold = new Scaffold({ genesis, privateKey });
  const contract = scaffold.context.execution.getContract(HASH_CONTRACT);
  assert(contract !== undefined, 'HASH_CONTRACT should be auto-registered');
  assertEquals(contract, hashContract);
});

Deno.test('HashContract: block with matching preimage verifies', async () => {
  const node = new SimNode('hash-test');
  node.execution.registerContract(HASH_CONTRACT, hashContract);

  const genesis = createGenesisBlock([]);
  node.receiveBlock(genesis, null);

  // The publishing block self-claims an ANSWER output under the HASH verifier
  // whose data IS the blob; hashContract.run reads it via getResult and checks
  // hash(blob) == verifier.params. See docs/protocol/results.md.
  const blob = new TextEncoder().encode('the quick brown fox');
  const blobHash = Hash.digest(blob);
  const outputs = [
    {
      verifier: { contract: HASH_CONTRACT, params: blobHash.toBytes() },
      value: 0,
      body: blob,
    },
  ];
  const block = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claimIndices: [0],
      outputs,
      declaredWeight: 10,
      refs: [],
      timestamp: 0,
    },
    secp.utils.randomPrivateKey(),
  );
  node.receiveBlock(block, null);

  const result = await node.execution.verifyBlock(block.hash);
  assert(result.accepted, `expected accept; rejected with: ${JSON.stringify(result)}`);
});

Deno.test('HashContract: block with mismatched preimage is rejected', async () => {
  const node = new SimNode('hash-mismatch');
  node.execution.registerContract(HASH_CONTRACT, hashContract);

  const genesis = createGenesisBlock([]);
  node.receiveBlock(genesis, null);

  // The verifier claims hash(X), but the answer body is Y -- digest mismatch.
  const claimedBlob = new TextEncoder().encode('claimed');
  const actualBlob = new TextEncoder().encode('different');
  const claimedHash = Hash.digest(claimedBlob);
  const outputs = [
    {
      verifier: { contract: HASH_CONTRACT, params: claimedHash.toBytes() },
      value: 0,
      body: actualBlob,
    },
  ];
  const block = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claimIndices: [0],
      outputs,
      declaredWeight: 10,
      refs: [],
      timestamp: 0,
    },
    secp.utils.randomPrivateKey(),
  );
  node.receiveBlock(block, null);

  const result = await node.execution.verifyBlock(block.hash);
  assertFalse(result.accepted, 'expected rejection on preimage mismatch');
});
